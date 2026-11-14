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
import { requireAdmin, setSessionCookie, SPACE_SESSION_SECONDS, spaceOf, type AdminAuth } from './auth.js';
import { DeckStore, deckToSetup } from './decks.js';
import { cleanJpeg, cleanVideo, MediaStore, newImageId, newVideoId, type ImageVariant } from './media.js';
import { spotAllowed } from './outlines.js';
import { lookUpPlace } from './places.js';
import { SAMPLE_PHOTO_COUNT, sampleDeckWithPhotos } from './sample.js';
import { TooManyRoomsError, type RoomManager } from './session/manager.js';
import type { RoomSetup } from './session/room.js';
import type { Sessions } from './session/sockets.js';
import { MAIN_SPACE, type SpaceStore } from './spaces.js';

const startSchema = z.strictObject({ deckId: z.string().regex(DECK_ID_PATTERN).optional() });
const placeSchema = z.strictObject({ url: z.string().max(MAX_LINK) });

/** How much one hosted space may keep, so nobody can fill the server. A server you run yourself has none. */
export interface SpaceLimits {
  decks: number;
  /** Photos and videos uploaded. */
  media: number;
  /** Games running at once. Starting another ends the oldest. */
  games: number;
  /** Of the photos and videos, how many may be videos, which are far bigger. */
  videos?: number;
  /** Bytes of photos and videos kept in storage, so a space can't fill it with large files. */
  bytes?: number;
}

export interface DeckRouteOptions {
  auth: AdminAuth;
  decks: DeckStore;
  media: MediaStore;
  rooms: RoomManager;
  sessions: Sessions;
  /** Set on a hosted server, where each space has its own join code. */
  spaces?: SpaceStore;
  limits?: SpaceLimits;
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

/** Everything in here shows real answers, so it all needs a signed-in presenter, and only reaches their own space. */
export function deckRoutes(options: DeckRouteOptions): FastifyPluginAsync {
  const { auth, decks, media, rooms, sessions, spaces, limits, fallbackSetup, onError, lookUp = fetch, maxVideoUploads = 4, maxPhotoUploads = 24, sampleDeck } = options;

  /** Photos named in a deck that aren't this space's own. */
  const foreignPhotos = async (space: string, content: DeckContent): Promise<number> => {
    const owned = await Promise.all(imagesInDeck(content).map((image) => media.owns(space, image)));
    return owned.filter((owns) => !owns).length;
  };

  /** Checks a deck about to be saved. Returns the reply to send instead, or null when it's fine. */
  const refuseDeck = async (space: string, content: DeckContent, reply: FastifyReply) => {
    if ((await foreignPhotos(space, content)) > 0) return reply.code(403).send({ error: 'not_your_photo' });
    return null;
  };

  const roomsOf = (space: string) => rooms.list().filter((room) => room.space === space);

  // Photos still on their way, per space. Each upload holds its places until it's answered,
  // so many sent at once can't all slip under the limit before any of them is saved.
  const uploading = new Map<string, number>();
  const reserve = (space: string, count: number) => {
    const othersPending = uploading.get(space) ?? 0;
    uploading.set(space, othersPending + count);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (uploading.get(space) ?? count) - count;
      if (left > 0) uploading.set(space, left);
      else uploading.delete(space);
    };
    return Object.assign(release, { othersPending });
  };

  return async (scope: FastifyInstance) => {
    // Runs before the body is read, so a stranger can't make the server take in a large upload.
    scope.addHook('onRequest', requireAdmin(auth));
    // Keeps a space that's being used from being cleared out as idle.
    scope.addHook('preHandler', async (request) => {
      if (spaces) await spaces.touch(spaceOf(request));
    });
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

    /** The space's join code and presenter link, on a hosted server. */
    scope.get('/api/admin/space', async (request) => {
      const space = spaceOf(request);
      const found = spaces && space !== MAIN_SPACE ? await spaces.get(space) : null;
      if (!found || !spaces) return { space: null };
      return { space: { code: found.code, presenterKey: `${found.id}.${spaces.presenterKey(found.id)}` } };
    });

    // A new presenter link. Every other device signed in to this space is signed out, this one stays in.
    scope.post('/api/admin/space/reset', async (request, reply) => {
      const space = spaceOf(request);
      const reset = spaces && space !== MAIN_SPACE ? await spaces.resetPresenterKey(space) : null;
      if (!reset || !spaces) return reply.code(404).send({ error: 'not_found' });
      // A TV signed in before the reset would otherwise keep receiving the game, answers included.
      sessions.dropHosts(roomsOf(space).map((room) => room.id));
      const session = auth.issue(space, SPACE_SESSION_SECONDS);
      setSessionCookie(reply, request, session.value, session.maxAge);
      return { space: { code: reset.code, presenterKey: `${reset.id}.${spaces.presenterKey(reset.id)}` } };
    });

    scope.get('/api/admin/rooms', async (request) => ({
      rooms: roomsOf(spaceOf(request))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((room) => ({
          id: room.id,
          title: room.title,
          playerCount: room.playerCount,
          finished: room.finished,
          updatedAt: room.updatedAt,
        })),
    }));

    scope.get('/api/admin/decks', async (request) => ({ decks: await decks.summaries(spaceOf(request)), sampleDeck }));

    const createDeck = async (space: string, content: DeckContent, reply: FastifyReply) => {
      const deck = await decks.create(space, content, limits?.decks);
      if (!deck) return reply.code(409).send({ error: 'too_many_decks' });
      return { deck };
    };

    scope.post('/api/admin/decks', async (request, reply) => {
      const content = deckContentSchema.safeParse(request.body);
      if (!content.success) return reply.code(400).send({ error: 'bad_deck' });
      const space = spaceOf(request);
      return (await refuseDeck(space, content.data, reply)) ?? createDeck(space, content.data, reply);
    });

    if (sampleDeck) {
      scope.post('/api/admin/decks/sample', async (request, reply) => {
        const space = spaceOf(request);
        const release = reserve(space, SAMPLE_PHOTO_COUNT);
        try {
          if (limits && (await media.countOwned(space)) + release.othersPending + SAMPLE_PHOTO_COUNT > limits.media) {
            return reply.code(409).send({ error: 'too_many_photos' });
          }
          if (limits && (await decks.count(space)) >= limits.decks) return reply.code(409).send({ error: 'too_many_decks' });
          return createDeck(space, await sampleDeckWithPhotos(media, space), reply);
        } finally {
          release();
        }
      });
    }

    scope.get('/api/admin/decks/:id', async (request, reply) => {
      const id = deckIdFrom(request.params);
      const deck = id ? await decks.get(spaceOf(request), id) : null;
      if (!deck) return reply.code(404).send({ error: 'not_found' });
      return { deck };
    });

    scope.put('/api/admin/decks/:id', async (request, reply) => {
      const id = deckIdFrom(request.params);
      if (!id) return reply.code(404).send({ error: 'not_found' });
      const body = saveDeckSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_deck' });
      const space = spaceOf(request);
      const refused = await refuseDeck(space, body.data.content, reply);
      if (refused) return refused;
      const outcome = await decks.save(space, id, body.data.revision, body.data.content);
      if (outcome.kind === 'missing') return reply.code(404).send({ error: 'not_found' });
      if (outcome.kind === 'conflict') return reply.code(409).send({ error: 'conflict' });
      return { revision: outcome.deck.revision };
    });

    scope.post('/api/admin/decks/:id/duplicate', async (request, reply) => {
      const id = deckIdFrom(request.params);
      const space = spaceOf(request);
      const deck = id ? await decks.get(space, id) : null;
      if (!deck) return reply.code(404).send({ error: 'not_found' });
      const title = `${deck.content.title} copy`.slice(0, MAX_DECK_TITLE);
      return createDeck(space, { ...deck.content, title }, reply);
    });

    /** Removes this space's photos that nothing points at any more. Duplicated decks share photos, and so do live games. */
    const deleteUnusedPhotos = async (space: string, images: string[]) => {
      const inUse = new Set<string>(rooms.list().flatMap((room) => room.imageIds()));
      for (const other of await decks.all(space)) imagesInDeck(other.content).forEach((image) => inUse.add(image));
      for (const image of new Set(images)) {
        if (!inUse.has(image)) {
          await media.deleteOwned(space, image).catch((error) => onError(error, 'Deleting a photo failed'));
        }
      }
    };

    scope.delete('/api/admin/decks/:id', async (request, reply) => {
      const id = deckIdFrom(request.params);
      const space = spaceOf(request);
      const deck = id ? await decks.get(space, id) : null;
      if (!deck || !id) return reply.code(404).send({ error: 'not_found' });
      await decks.delete(space, id);
      await deleteUnusedPhotos(space, imagesInDeck(deck.content));
      return { ok: true };
    });

    // Games the server ends by itself, when they're a day old or it's full, go the same way.
    rooms.onDropped(async (room) => {
      sessions.endRoom(room.id);
      await deleteUnusedPhotos(room.space, room.imageIds());
    });

    const endRoom = async (space: string, id: string) => {
      const room = await rooms.delete(id);
      if (!room) return null;
      sessions.endRoom(id);
      // Only matters when the deck went first: until now this game was keeping its photos.
      await deleteUnusedPhotos(space, room.imageIds());
      return room;
    };

    // Ends a game for everyone in it. Its deck stays, so it can be played again.
    scope.delete('/api/admin/rooms/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const space = spaceOf(request);
      const owned = ROOM_ID_PATTERN.test(id) && rooms.get(id)?.space === space;
      const room = owned ? await endRoom(space, id) : null;
      if (!room) return reply.code(404).send({ error: 'not_found' });
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

    const holding = new WeakMap<FastifyRequest, () => void>();

    // Checked before the body is read, so a full space can't send another 100 MB first.
    const roomForMore = async (request: FastifyRequest, reply: FastifyReply) => {
      const space = auth.presenterSpace(request.headers);
      if (!limits || !space) return;
      const release = reserve(space, 1);
      holding.set(request, release);
      if ((await media.countOwned(space)) + release.othersPending >= limits.media) {
        await reply.code(409).send({ error: 'too_many_photos' });
      }
    };
    // Also checked before the body is read, by the size the upload says it is (or the most it may
    // be). Uploads arriving at once can each pass before any is counted, but the upload slots keep
    // how far over that can go small.
    const roomForBytes = async (request: FastifyRequest, reply: FastifyReply) => {
      const space = auth.presenterSpace(request.headers);
      if (limits?.bytes === undefined || !space) return;
      const declared = Number(request.headers['content-length']) || request.routeOptions.bodyLimit;
      if ((await media.bytesOwned(space)) + declared > limits.bytes) {
        await reply.code(409).send({ error: 'space_full' });
      }
    };
    const letGo = async (request: FastifyRequest) => {
      holding.get(request)?.();
      holding.delete(request);
    };
    const counted = { onRequest: [roomForMore, roomForBytes, holdPhotoSlot], onResponse: letGo, onRequestAbort: letGo, bodyLimit: MAX_UPLOAD_BYTES };

    scope.post('/api/admin/images', counted, async (request, reply) => {
      const clean = cleanJpeg(request.body as Buffer);
      if (!clean) return reply.code(400).send({ error: 'not_a_photo' });
      const id = newImageId();
      await media.save(id, 'full', clean.body);
      await media.claim(spaceOf(request), id, clean.body.length);
      return { id, width: clean.width, height: clean.height };
    });

    // A video is sent as it is, then its poster follows as `full` and `small`, just like a photo's.
    // Each video may be 100 MB, so a space holds far fewer of them than photos. Counted with the
    // ones still arriving, like photos, so parallel uploads can't slip past it.
    const holdingVideo = new WeakMap<FastifyRequest, () => void>();
    const roomForVideo = async (request: FastifyRequest, reply: FastifyReply) => {
      const space = auth.presenterSpace(request.headers);
      if (limits?.videos === undefined || !space) return;
      const release = reserve(`video:${space}`, 1);
      holdingVideo.set(request, release);
      if ((await media.countOwnedVideos(space)) + release.othersPending >= limits.videos) {
        await reply.code(409).send({ error: 'too_many_videos' });
      }
    };
    const letGoVideo = async (request: FastifyRequest) => {
      holdingVideo.get(request)?.();
      holdingVideo.delete(request);
    };

    scope.post(
      '/api/admin/videos',
      {
        onRequest: [roomForMore, roomForVideo, roomForBytes, holdUploadSlot],
        onResponse: [letGo, letGoVideo],
        onRequestAbort: [letGo, letGoVideo],
        bodyLimit: MAX_VIDEO_BYTES,
      },
      async (request, reply) => {
        const clean = cleanVideo(request.body as Buffer);
        if (!clean) return reply.code(400).send({ error: 'not_a_video' });
        const id = newVideoId();
        await media.save(id, 'video', clean);
        await media.claim(spaceOf(request), id, clean.length);
        return { id };
      },
    );

    /**
     * A poster or small copy can be added once and never replaced. Photo addresses reach every
     * phone in a game, so otherwise anyone signed in could swap a picture in a deck that isn't
     * theirs. Sending the same copy again is fine, so the builder's retries still work.
     */
    const saveOnce = async (space: string, id: string, variant: ImageVariant, body: Buffer, reply: FastifyReply) => {
      const existing = await media.read(id, variant);
      if (existing) {
        if (existing.equals(body)) return { ok: true };
        return reply.code(409).send({ error: 'already_added' });
      }
      await media.save(id, variant, body);
      await media.addBytes(space, id, body.length);
      return { ok: true };
    };

    const photoUpload = { onRequest: [roomForBytes, holdPhotoSlot], bodyLimit: MAX_UPLOAD_BYTES };

    scope.put('/api/admin/images/:id/full', photoUpload, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isVideoId(id) || !(await media.owns(spaceOf(request), id)) || !(await media.videoFile(id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const clean = cleanJpeg(request.body as Buffer);
      if (!clean) return reply.code(400).send({ error: 'not_a_photo' });
      return saveOnce(spaceOf(request), id, 'full', clean.body, reply);
    });

    // The phone-sized copy. Until it arrives, phones are simply given the full one.
    scope.put('/api/admin/images/:id/small', photoUpload, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!MEDIA_ID_PATTERN.test(id) || !(await media.owns(spaceOf(request), id)) || !(await media.exists(id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const clean = cleanJpeg(request.body as Buffer);
      if (!clean) return reply.code(400).send({ error: 'not_a_photo' });
      return saveOnce(spaceOf(request), id, 'small', clean.body, reply);
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
      const space = spaceOf(request);
      const joinCode = spaces && space !== MAIN_SPACE ? (await spaces.get(space))?.code : undefined;

      let setup: RoomSetup;
      if (!body.data.deckId) {
        setup = fallbackSetup;
      } else {
        const deck = await decks.get(space, body.data.deckId);
        if (!deck) return reply.code(404).send({ error: 'not_found' });
        const problems = [
          ...deckProblems(deck.content),
          ...locationProblems(deck.content),
          ...(await missingPhotos(deck, media)),
          ...((await foreignPhotos(space, deck.content)) > 0 ? ['Some photos in this deck belong to someone else. Add them again.'] : []),
        ];
        if (problems.length > 0) return reply.code(409).send({ error: 'not_ready', problems });
        setup = deckToSetup(deck.content);
        void media.warm(imagesInDeck(deck.content)).catch((error) => onError(error, 'Warming photos failed'));
      }

      if (limits) {
        const running = roomsOf(space).sort((a, b) => a.updatedAt - b.updatedAt);
        for (const old of running.slice(0, Math.max(0, running.length - limits.games + 1))) await endRoom(space, old.id);
      }
      const room = await startRoom({ ...setup, space, joinCode }, reply);
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
