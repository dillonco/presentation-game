import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ROOM_ID_PATTERN } from '../shared/constants.js';
import {
  DECK_ID_PATTERN,
  deckContentSchema,
  deckProblems,
  imagesInDeck,
  isVideoId,
  MAX_DECK_TITLE,
  MAX_LINK,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
  MEDIA_ID_PATTERN,
  saveDeckSchema,
  type DeckContent,
  type StoredDeck,
} from '../shared/deck.js';
import { requireAdmin, type AdminAuth } from './auth.js';
import { DeckStore, deckToSetup } from './decks.js';
import { cleanJpeg, cleanVideo, MediaStore, newImageId, newVideoId } from './media.js';
import { spotAllowed } from './outlines.js';
import { lookUpPlace } from './places.js';
import { sampleDeckWithPhotos } from './sample.js';
import { TooManyRoomsError, type RoomManager } from './session/manager.js';
import type { RoomSetup } from './session/room.js';
import type { Sessions } from './session/sockets.js';

const startSchema = z.strictObject({ deckId: z.string().regex(DECK_ID_PATTERN).optional() });
const placeSchema = z.strictObject({ url: z.string().max(MAX_LINK) });

export interface DeckRouteOptions {
  auth: AdminAuth;
  decks: DeckStore;
  media: MediaStore;
  rooms: RoomManager;
  sessions: Sessions;
  /** What a game plays when no deck is named. Tests use it for short games. */
  fallbackSetup: RoomSetup;
  onError: (error: unknown, message: string) => void;
  /** Follows short Google Maps links. Tests swap it so they never reach the network. */
  lookUp?: typeof fetch;
  /** How many videos may be arriving at once. */
  maxVideoUploads?: number;
  /** How many photos may be arriving at once. */
  maxPhotoUploads?: number;
  /** Whether the sample deck can be added. Only a development server offers it. */
  sampleDeck: boolean;
}

/**
 * A ceiling on uploads arriving at once, server-wide, since each is held in memory while it's
 * checked. Checked before the body is read. The builder retries a refused one.
 */
function uploadSlots(max: number) {
  let arriving = 0;
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    if (arriving >= max) {
      await reply.code(503).header('retry-after', '5').send({ error: 'busy' });
      return;
    }
    arriving += 1;
    let released = false;
    reply.raw.once('close', () => {
      if (released) return;
      released = true;
      arriving -= 1;
    });
  };
}

function deckIdFrom(params: unknown): string | null {
  const { id } = params as { id: string };
  return DECK_ID_PATTERN.test(id) ? id : null;
}

/** Everything in here shows real answers, so it all needs the signed-in presenter. */
export function deckRoutes(options: DeckRouteOptions): FastifyPluginAsync {
  const { auth, decks, media, rooms, sessions, fallbackSetup, onError, lookUp = fetch, maxVideoUploads = 4, maxPhotoUploads = 24, sampleDeck } = options;

  return async (scope: FastifyInstance) => {
    // Runs before the body is read, so a stranger can't make the server take in a large upload.
    scope.addHook('onRequest', requireAdmin(auth));
    // These parsers keep the server's 1 MB limit. Only the upload routes below raise it, each for
    // itself, so a large body sent to any other route is refused before it's read into memory.
    scope.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    // The builder sends every video as this, whatever the file called itself. MOV files share the format.
    scope.addContentTypeParser('video/mp4', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    /**
     * A video is held in memory while it's checked, twice over, so only a few may arrive at once.
     * Checked before the body is read. The builder retries a refused one.
     */
    const holdUploadSlot = uploadSlots(maxVideoUploads);
    /** Photos are smaller, but they're held in memory too, so there's a ceiling on them as well. */
    const holdPhotoSlot = uploadSlots(maxPhotoUploads);

    scope.get('/api/admin/rooms', async () => ({
      rooms: rooms
        .list()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((room) => ({
          id: room.id,
          title: room.title,
          playerCount: room.playerCount,
          finished: room.finished,
          updatedAt: room.updatedAt,
        })),
    }));

    scope.get('/api/admin/decks', async () => ({ decks: await decks.summaries(), sampleDeck }));

    scope.post('/api/admin/decks', async (request, reply) => {
      const content = deckContentSchema.safeParse(request.body);
      if (!content.success) return reply.code(400).send({ error: 'bad_deck' });
      return { deck: await decks.create(content.data) };
    });

    if (sampleDeck) {
      scope.post('/api/admin/decks/sample', async () => ({ deck: await decks.create(await sampleDeckWithPhotos(media)) }));
    }

    scope.get('/api/admin/decks/:id', async (request, reply) => {
      const id = deckIdFrom(request.params);
      const deck = id ? await decks.get(id) : null;
      if (!deck) return reply.code(404).send({ error: 'not_found' });
      return { deck };
    });

    scope.put('/api/admin/decks/:id', async (request, reply) => {
      const id = deckIdFrom(request.params);
      if (!id) return reply.code(404).send({ error: 'not_found' });
      const body = saveDeckSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_deck' });
      const outcome = await decks.save(id, body.data.revision, body.data.content);
      if (outcome.kind === 'missing') return reply.code(404).send({ error: 'not_found' });
      if (outcome.kind === 'conflict') return reply.code(409).send({ error: 'conflict' });
      return { revision: outcome.deck.revision };
    });

    scope.post('/api/admin/decks/:id/duplicate', async (request, reply) => {
      const id = deckIdFrom(request.params);
      const deck = id ? await decks.get(id) : null;
      if (!deck) return reply.code(404).send({ error: 'not_found' });
      const title = `${deck.content.title} copy`.slice(0, MAX_DECK_TITLE);
      return { deck: await decks.create({ ...deck.content, title }) };
    });

    /** Removes photos that nothing points at any more. Duplicated decks share photos, and so do live games. */
    const deleteUnusedPhotos = async (images: string[]) => {
      const inUse = new Set<string>(rooms.list().flatMap((room) => room.imageIds()));
      for (const other of await decks.all()) imagesInDeck(other.content).forEach((image) => inUse.add(image));
      for (const image of new Set(images)) {
        if (!inUse.has(image)) await media.delete(image).catch((error) => onError(error, 'Deleting a photo failed'));
      }
    };

    scope.delete('/api/admin/decks/:id', async (request, reply) => {
      const id = deckIdFrom(request.params);
      const deck = id ? await decks.get(id) : null;
      if (!deck || !id) return reply.code(404).send({ error: 'not_found' });
      await decks.delete(id);
      await deleteUnusedPhotos(imagesInDeck(deck.content));
      return { ok: true };
    });

    // Games the server ends by itself, when they're a day old or it's full, go the same way.
    rooms.onDropped(async (room) => {
      sessions.endRoom(room.id);
      await deleteUnusedPhotos(room.imageIds());
    });

    // Ends a game for everyone in it. Its deck stays, so it can be played again.
    scope.delete('/api/admin/rooms/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const room = ROOM_ID_PATTERN.test(id) ? await rooms.delete(id) : null;
      if (!room) return reply.code(404).send({ error: 'not_found' });
      sessions.endRoom(id);
      // Only matters when the deck went first: until now this game was keeping its photos.
      await deleteUnusedPhotos(room.imageIds());
      return { ok: true };
    });

    // A pasted Google Maps link, turned into a named spot for the tips map.
    scope.post('/api/admin/places', async (request, reply) => {
      const body = placeSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'not_a_map_link' });
      const found = await lookUpPlace(body.data.url, lookUp);
      if (!found.ok) return reply.code(found.error === 'not_a_map_link' ? 400 : 422).send({ error: found.error });
      return { place: found.place };
    });

    const photoUpload = { onRequest: holdPhotoSlot, bodyLimit: MAX_UPLOAD_BYTES };

    scope.post('/api/admin/images', photoUpload, async (request, reply) => {
      const clean = cleanJpeg(request.body as Buffer);
      if (!clean) return reply.code(400).send({ error: 'not_a_photo' });
      const id = newImageId();
      await media.save(id, 'full', clean.body);
      return { id, width: clean.width, height: clean.height };
    });

    // A video is sent as it is, then its poster follows as `full` and `small`, just like a photo's.
    scope.post('/api/admin/videos', { onRequest: holdUploadSlot, bodyLimit: MAX_VIDEO_BYTES }, async (request, reply) => {
      const clean = cleanVideo(request.body as Buffer);
      if (!clean) return reply.code(400).send({ error: 'not_a_video' });
      const id = newVideoId();
      await media.save(id, 'video', clean);
      return { id };
    });

    scope.put('/api/admin/images/:id/full', photoUpload, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isVideoId(id) || !(await media.videoFile(id))) return reply.code(404).send({ error: 'not_found' });
      const clean = cleanJpeg(request.body as Buffer);
      if (!clean) return reply.code(400).send({ error: 'not_a_photo' });
      await media.save(id, 'full', clean.body);
      return { ok: true };
    });

    // The phone-sized copy. Until it arrives, phones are simply given the full one.
    scope.put('/api/admin/images/:id/small', photoUpload, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!MEDIA_ID_PATTERN.test(id) || !(await media.exists(id))) return reply.code(404).send({ error: 'not_found' });
      const clean = cleanJpeg(request.body as Buffer);
      if (!clean) return reply.code(400).send({ error: 'not_a_photo' });
      await media.save(id, 'small', clean.body);
      return { ok: true };
    });

    const startRoom = async (setup: RoomSetup, reply: FastifyReply) => {
      try {
        return await rooms.create(setup);
      } catch (error) {
        if (!(error instanceof TooManyRoomsError)) throw error;
        await reply.code(503).send({
          error: 'too_many_games',
          problems: ['Too many games are running on this server right now. End an old one, or try again later.'],
        });
        return null;
      }
    };

    scope.post('/api/admin/rooms', async (request, reply) => {
      const body = startSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });

      let setup: RoomSetup;
      if (!body.data.deckId) {
        setup = fallbackSetup;
      } else {
        const deck = await decks.get(body.data.deckId);
        if (!deck) return reply.code(404).send({ error: 'not_found' });
        const problems = [
          ...deckProblems(deck.content),
          ...locationProblems(deck.content),
          ...(await missingPhotos(deck, media)),
        ];
        if (problems.length > 0) return reply.code(409).send({ error: 'not_ready', problems });
        setup = deckToSetup(deck.content);
        void media.warm(imagesInDeck(deck.content)).catch((error) => onError(error, 'Warming photos failed'));
      }

      const room = await startRoom(setup, reply);
      if (!room) return reply;
      return { id: room.id };
    });
  };
}

/**
 * The builder's check only knows the country's box, so a spot out at sea can get past it. Nobody
 * could put a pin there, so this checks against the exact outline before a game starts.
 */
function locationProblems(content: DeckContent): string[] {
  const problems: string[] = [];
  for (const game of content.games) {
    if (game.type !== 'geo') continue;
    game.items.forEach((item, index) => {
      if (item.lat === null || item.lng === null) return;
      if (!spotAllowed(content.region.country, { lat: item.lat, lng: item.lng })) {
        problems.push(`Where was this?, photo ${index + 1}: the location is too far from ${content.region.country}.`);
      }
    });
  }
  return problems;
}

/** An imported deck can name photos that only exist on another server. */
async function missingPhotos(deck: StoredDeck, media: MediaStore): Promise<string[]> {
  const images = imagesInDeck(deck.content);
  const found = await Promise.all(images.map((image) => media.exists(image)));
  const missing = found.filter((exists) => !exists).length;
  if (missing === 0) return [];
  return [
    missing === 1
      ? "1 photo in this deck isn't on this server. Remove it or add it again."
      : `${missing} photos in this deck aren't on this server. Remove them or add them again.`,
  ];
}

/** Public, because phones need photos, but the addresses are random and only handed out when a round starts. */
export function registerMediaRoute(fastify: FastifyInstance, media: MediaStore): void {
  fastify.get('/media/:id/:file', async (request, reply) => {
    const { id, file } = request.params as { id: string; file: string };
    if (file === 'video.mp4') return sendVideo(request.headers.range, id, media, reply);
    const variant = file === 'full.jpg' ? 'full' : file === 'small.jpg' ? 'small' : null;
    if (!variant || !MEDIA_ID_PATTERN.test(id)) return reply.code(404).send({ error: 'not_found' });

    let body = await media.read(id, variant);
    const isFallback = !body && variant === 'small';
    if (isFallback) body = await media.read(id, 'full');
    if (!body) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', isFallback ? 'no-cache' : 'public, max-age=31536000, immutable')
      .send(body);
  });
}

/** Which bytes a `Range` header asks for, or null when it can't be met. Only single ranges, which is all players ask for. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return null;
  return { start, end };
}

/** Sent in pieces from the local copy, because Safari won't play a video any other way. */
async function sendVideo(range: string | undefined, id: string, media: MediaStore, reply: FastifyReply) {
  let path = isVideoId(id) ? await media.videoFile(id) : null;
  let info = path ? await stat(path).catch(() => null) : null;
  // The local copy can make way for newer files at any moment, so fetch it again if it just went.
  if (path && !info) {
    path = await media.videoFile(id);
    info = path ? await stat(path).catch(() => null) : null;
  }
  if (!path || !info) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });
  const { size } = info;
  reply
    .header('content-type', 'video/mp4')
    .header('accept-ranges', 'bytes')
    .header('cache-control', 'public, max-age=31536000, immutable');
  if (!range) {
    // Naming the last byte lets the stream finish the moment it reads it. Without it, the stream
    // waits for one more read to find the end of the file, and the reply stays open until then,
    // even though the player already has every byte it was promised.
    const whole = createReadStream(path, { start: 0, end: Math.max(size - 1, 0) });
    return reply.header('content-length', size).send(whole);
  }
  const wanted = parseRange(range, size);
  if (!wanted) return reply.code(416).header('content-range', `bytes */${size}`).send();
  return reply
    .code(206)
    .header('content-range', `bytes ${wanted.start}-${wanted.end}/${size}`)
    .header('content-length', wanted.end - wanted.start + 1)
    .send(createReadStream(path, { start: wanted.start, end: wanted.end }));
}
