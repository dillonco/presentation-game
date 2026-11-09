import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deckProblems,
  emptyDeck,
  imagesInDeck,
  MAX_UPLOAD_BYTES,
  sampleDeck,
  type DeckContent,
  type StoredDeck,
} from '../../shared/deck.js';
import { cleanJpeg } from '../../server/media.js';
import type { GuestView, HostView } from '../../shared/protocol.js';
import { command, hostHello, newToken, nextEvent, PASSWORD, send, startHarness, type Harness } from './helpers.js';
import { phoneVideo, PICTURE } from '../fixtures/mp4.js';

const WITH_GPS = readFileSync('tests/fixtures/gps.jpg');
const PLAIN = readFileSync('tests/fixtures/plain.jpg');
const SOME_DECK_ID = 'a'.repeat(16);
const SOME_IMAGE_ID = 'b'.repeat(22);

describe('decks and photos', () => {
  let harness: Harness;
  let cookie: string;

  beforeEach(async () => {
    harness = await startHarness();
    cookie = await harness.signIn();
  });

  afterEach(() => harness.stop());

  function api(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return fetch(`${harness.url}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function create(content: DeckContent = sampleDeck()): Promise<StoredDeck> {
    const response = await api('/api/admin/decks', 'POST', content);
    expect(response.status).toBe(200);
    return ((await response.json()) as { deck: StoredDeck }).deck;
  }

  async function upload(photo: Buffer = PLAIN): Promise<string> {
    const response = await fetch(`${harness.url}/api/admin/images`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array(photo),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  }

  function sampleDeckWithOneWord(): DeckContent {
    return {
      ...emptyDeck(),
      games: [{ type: 'define', settings: {}, items: [{ word: 'komorebi', definition: 'Sunlight through leaves' }] }],
    };
  }

  function withPhoto(image: string, title = 'Photos'): DeckContent {
    return { ...emptyDeck(), title, games: [{ type: 'caption', settings: {}, items: [{ image }] }] };
  }

  describe('who can reach them', () => {
    it.each([
      ['GET', '/api/admin/decks'],
      ['POST', '/api/admin/decks'],
      ['GET', `/api/admin/decks/${SOME_DECK_ID}`],
      ['PUT', `/api/admin/decks/${SOME_DECK_ID}`],
      ['DELETE', `/api/admin/decks/${SOME_DECK_ID}`],
      ['POST', `/api/admin/decks/${SOME_DECK_ID}/duplicate`],
      ['POST', '/api/admin/decks/sample'],
      ['POST', '/api/admin/images'],
      ['PUT', `/api/admin/images/${SOME_IMAGE_ID}/small`],
      ['POST', '/api/admin/videos'],
      ['PUT', `/api/admin/images/v${SOME_IMAGE_ID}/full`],
      ['POST', '/api/admin/rooms'],
      ['DELETE', `/api/admin/rooms/${'c'.repeat(22)}`],
    ])('refuses %s %s without signing in', async (method, path) => {
      const response = await fetch(`${harness.url}${path}`, { method });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it.each([
      ['another site', { 'sec-fetch-site': 'cross-site' }],
      ['a neighbouring app on the same hosting domain', { 'sec-fetch-site': 'same-site' }],
      ['an older browser on another site', { origin: 'https://evil.example' }],
    ])('refuses changes sent from %s, even with a presenter cookie', async (_from, headers) => {
      for (const [method, path, body] of [
        ['POST', '/api/admin/decks', sampleDeck()],
        ['DELETE', `/api/admin/decks/${SOME_DECK_ID}`, undefined],
        ['POST', '/api/admin/login', { password: 'anything' }],
        ['POST', '/%61pi/admin/decks', sampleDeck()],
      ] as const) {
        const response = await api(path, method, body, headers);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'cross_site' });
      }
    });

    it("takes changes from this app's own pages", async () => {
      const ownPage = await api('/api/admin/decks', 'POST', sampleDeck(), { 'sec-fetch-site': 'same-origin' });
      expect(ownPage.status).toBe(200);
      const olderBrowser = await api('/api/admin/decks', 'POST', sampleDeck(), {
        origin: harness.url,
      });
      expect(olderBrowser.status).toBe(200);
      // Reading is always fine: a cross-site page can't see the reply.
      expect((await api('/api/admin/decks', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
    });

    it('says so when the server already has as many games running as it can hold', async () => {
      await harness.stop();
      harness = await startHarness({ maxRooms: 2 });
      cookie = await harness.signIn();
      expect((await api('/api/admin/rooms', 'POST')).status).toBe(200);
      expect((await api('/api/admin/rooms', 'POST')).status).toBe(200);
      const third = await api('/api/admin/rooms', 'POST');
      expect(third.status).toBe(503);
      expect(await third.json()).toMatchObject({ error: 'too_many_games', problems: [expect.any(String)] });
      expect(harness.app.rooms.list()).toHaveLength(2);
    });

    it('signs in with a __Host- cookie over HTTPS', async () => {
      const response = await fetch(`${harness.url}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const set = response.headers.get('set-cookie')!;
      expect(set).toMatch(/^__Host-tp_admin=v3\./);
      expect(set).toContain('; Secure');
      expect(set).toContain('; Path=/');
      expect(set).not.toContain('Domain');
      const secure = set.split(';')[0]!;
      const me = await fetch(`${harness.url}/api/admin/me`, { headers: { cookie: secure, 'x-forwarded-proto': 'https' } });
      expect(await me.json()).toEqual({ signedIn: true });
    });

    it('refuses a forged cookie', async () => {
      const response = await fetch(`${harness.url}/api/admin/decks`, {
        headers: { cookie: 'tp_admin=v1.9999999999.forged' },
      });
      expect(response.status).toBe(401);
    });

    it('turns a stranger away before reading a large upload', async () => {
      const response = await fetch(`${harness.url}/api/admin/images`, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: new Uint8Array(MAX_UPLOAD_BYTES + 1),
      });
      expect(response.status).toBe(401);
    });

    it('never lets a browser or proxy keep deck data', async () => {
      const response = await api('/api/admin/decks');
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('saving', () => {
    it('stores a deck and lists a summary of it', async () => {
      const deck = await create();
      const listed = (await (await api('/api/admin/decks')).json()) as { decks: unknown[] };
      expect(listed.decks).toEqual([
        { id: deck.id, title: 'Sample deck', updatedAt: deck.updatedAt, games: [{ type: 'define', count: 3 }] },
      ]);
      // The list never needs real answers, so it doesn't carry them.
      expect(JSON.stringify(listed)).not.toContain('Sunlight');
    });

    it('saves changes and moves the revision on', async () => {
      const deck = await create();
      const response = await api(`/api/admin/decks/${deck.id}`, 'PUT', {
        revision: deck.revision,
        content: { ...deck.content, title: 'Renamed' },
      });
      expect(await response.json()).toEqual({ revision: 2 });
      const reread = (await (await api(`/api/admin/decks/${deck.id}`)).json()) as { deck: StoredDeck };
      expect(reread.deck.content.title).toBe('Renamed');
      expect(reread.deck.revision).toBe(2);
    });

    it('stops an old tab overwriting newer work', async () => {
      const deck = await create();
      await api(`/api/admin/decks/${deck.id}`, 'PUT', { revision: 1, content: { ...deck.content, title: 'Newer' } });
      const stale = await api(`/api/admin/decks/${deck.id}`, 'PUT', {
        revision: 1,
        content: { ...deck.content, title: 'Older' },
      });
      expect(stale.status).toBe(409);
      const reread = (await (await api(`/api/admin/decks/${deck.id}`)).json()) as { deck: StoredDeck };
      expect(reread.deck.content.title).toBe('Newer');
    });

    it('lets only one of two simultaneous saves through', async () => {
      const deck = await create();
      const results = await Promise.all(
        ['One', 'Two', 'Three', 'Four'].map((title) =>
          api(`/api/admin/decks/${deck.id}`, 'PUT', { revision: 1, content: { ...deck.content, title } }),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 409, 409, 409]);
    });

    it.each([
      ['a malformed deck', { title: 7 }],
      ['extra fields', { ...emptyDeck(), isAdmin: true }],
      ['a title far too long', { ...emptyDeck(), title: 'x'.repeat(500) }],
    ])('refuses %s', async (_name, content) => {
      expect((await api('/api/admin/decks', 'POST', content)).status).toBe(400);
    });

    it('answers plainly for a deck that does not exist', async () => {
      expect((await api(`/api/admin/decks/${SOME_DECK_ID}`)).status).toBe(404);
      expect((await api(`/api/admin/decks/..%2F..%2Fsecret`)).status).toBe(404);
      expect(
        (await api(`/api/admin/decks/${SOME_DECK_ID}`, 'PUT', { revision: 1, content: emptyDeck() })).status,
      ).toBe(404);
    });

    it('duplicates a deck as a separate copy', async () => {
      const deck = await create();
      const copy = ((await (await api(`/api/admin/decks/${deck.id}/duplicate`, 'POST')).json()) as { deck: StoredDeck }).deck;
      expect(copy.id).not.toBe(deck.id);
      expect(copy.content.title).toBe('Sample deck copy');
      expect(copy.content.games).toEqual(deck.content.games);
    });

    it('survives a server restart', async () => {
      const deck = await create();
      const photo = await upload();
      await harness.restart();
      cookie = await harness.signIn();
      const reread = (await (await api(`/api/admin/decks/${deck.id}`)).json()) as { deck: StoredDeck };
      expect(reread.deck.content).toEqual(deck.content);
      expect((await fetch(`${harness.url}/media/${photo}/full.jpg`)).status).toBe(200);
    });
  });

  describe('photos', () => {
    it('serves an upload with no location or camera details, even if the browser left them in', async () => {
      expect(WITH_GPS.includes('SecretCameraMake')).toBe(true);
      const id = await upload(WITH_GPS);
      const served = Buffer.from(await (await fetch(`${harness.url}/media/${id}/full.jpg`)).arrayBuffer());
      expect(served.includes('SecretCameraMake')).toBe(false);
      expect(served.includes('Exif')).toBe(false);
      expect(served.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });

    it('serves photos to anyone with the address, cached for good, with no signing in', async () => {
      const id = await upload();
      const response = await fetch(`${harness.url}/media/${id}/full.jpg`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('gives phones the small copy, or the full one until it arrives', async () => {
      const id = await upload(WITH_GPS);
      const fallback = await fetch(`${harness.url}/media/${id}/small.jpg`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get('cache-control')).toBe('no-cache');

      const small = await fetch(`${harness.url}/api/admin/images/${id}/small`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'image/jpeg' },
        body: new Uint8Array(PLAIN),
      });
      expect(small.status).toBe(200);
      const served = await fetch(`${harness.url}/media/${id}/small.jpg`);
      expect(served.headers.get('cache-control')).toContain('immutable');
      expect((await served.arrayBuffer()).byteLength).toBeLessThan(WITH_GPS.length);
    });

    it("never replaces a small copy once it's there, though the same copy again is fine", async () => {
      const id = await upload(WITH_GPS);
      const put = (body: Buffer) =>
        fetch(`${harness.url}/api/admin/images/${id}/small`, {
          method: 'PUT',
          headers: { cookie, 'content-type': 'image/jpeg' },
          body: new Uint8Array(body),
        });
      expect((await put(PLAIN)).status).toBe(200);
      // A retry after a lost reply.
      expect((await put(PLAIN)).status).toBe(200);
      const swap = await put(WITH_GPS);
      expect(swap.status).toBe(409);
      expect(await swap.json()).toEqual({ error: 'already_added' });
      const served = Buffer.from(await (await fetch(`${harness.url}/media/${id}/small.jpg`)).arrayBuffer());
      expect(served).toEqual(cleanJpeg(PLAIN)!.body);
    });

    it('needs the photo to exist before adding a small copy of it', async () => {
      const response = await fetch(`${harness.url}/api/admin/images/${SOME_IMAGE_ID}/small`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'image/jpeg' },
        body: new Uint8Array(PLAIN),
      });
      expect(response.status).toBe(404);
    });

    it.each([
      ['a web page pretending to be a photo', Buffer.from('<html><script>alert(1)</script></html>')],
      ['a cut-off photo', PLAIN.subarray(0, 100)],
    ])('refuses %s', async (_name, body) => {
      const response = await fetch(`${harness.url}/api/admin/images`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'image/jpeg' },
        body: new Uint8Array(body),
      });
      expect(response.status).toBe(400);
    });

    it('refuses anything labelled as another type', async () => {
      const response = await fetch(`${harness.url}/api/admin/images`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'text/html' },
        body: '<html></html>',
      });
      expect(response.status).toBe(415);
    });

    it('refuses an upload over the limit', async () => {
      // The server answers and hangs up before taking the rest, so the sender may see the
      // connection close before it reads the 413. Either way, nothing was taken in.
      const status = await fetch(`${harness.url}/api/admin/images`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'image/jpeg' },
        body: new Uint8Array(MAX_UPLOAD_BYTES + 1),
      }).then(
        (response) => response.status,
        (error: Error) => ((error.cause as { code?: string } | undefined)?.code === 'EPIPE' ? 413 : Promise.reject(error)),
      );
      expect(status).toBe(413);
    });

    it.each([
      ['a name that does not exist', `/media/${SOME_IMAGE_ID}/full.jpg`],
      ['a malformed name', '/media/short/full.jpg'],
      ['another file name', `/media/${SOME_IMAGE_ID}/meta.json`],
      ['a path out of the folder', '/media/..%2F..%2F..%2Fetc%2Fpasswd/full.jpg'],
    ])('finds nothing for %s', async (_name, path) => {
      expect((await fetch(`${harness.url}${path}`)).status).toBe(404);
    });

    it('only stores them under random names', async () => {
      const id = await upload();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(await harness.app.storage.list('images/')).toEqual([`images/${id}/full.jpg`]);
    });
  });

  describe('videos', () => {
    async function uploadVideo(video: Buffer = phoneVideo()): Promise<string> {
      const response = await fetch(`${harness.url}/api/admin/videos`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'video/mp4' },
        body: new Uint8Array(video),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { id: string }).id;
    }

    function putStill(id: string, variant: 'full' | 'small', photo: Buffer = PLAIN) {
      return fetch(`${harness.url}/api/admin/images/${id}/${variant}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'image/jpeg' },
        body: new Uint8Array(photo),
      });
    }

    async function addVideo(): Promise<string> {
      const id = await uploadVideo();
      expect((await putStill(id, 'full')).status).toBe(200);
      expect((await putStill(id, 'small')).status).toBe(200);
      return id;
    }

    it('serves an upload with no location or camera details', async () => {
      const id = await addVideo();
      expect(id).toMatch(/^v[A-Za-z0-9_-]{22}$/);
      const response = await fetch(`${harness.url}/media/${id}/video.mp4`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      const served = Buffer.from(await response.arrayBuffer());
      expect(served.length).toBe(phoneVideo().length);
      expect(served.includes(PICTURE)).toBe(true);
      expect(served.includes('SecretCameraMake')).toBe(false);
      expect(served.includes('+35.6586')).toBe(false);
    });

    it('sends the part a player asks for', async () => {
      const id = await addVideo();
      const whole = phoneVideo().length;
      const part = await fetch(`${harness.url}/media/${id}/video.mp4`, { headers: { range: 'bytes=4-7' } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe(`bytes 4-7/${whole}`);
      expect(Buffer.from(await part.arrayBuffer()).toString('latin1')).toBe('ftyp');

      const beyond = await fetch(`${harness.url}/media/${id}/video.mp4`, { headers: { range: `bytes=${whole}-` } });
      expect(beyond.status).toBe(416);
      expect(beyond.headers.get('content-range')).toBe(`bytes */${whole}`);
    });

    it('fetches it from storage again when the local copy is gone', async () => {
      const id = await addVideo();
      await rm(join(harness.root, 'media-cache'), { recursive: true, force: true });
      const response = await fetch(`${harness.url}/media/${id}/video.mp4`, { headers: { range: 'bytes=0-3' } });
      expect(response.status).toBe(206);
    });

    it('shows its poster wherever a photo would be', async () => {
      const id = await addVideo();
      for (const file of ['full.jpg', 'small.jpg']) {
        const response = await fetch(`${harness.url}/media/${id}/${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/jpeg');
      }
    });

    it('takes only a few videos at once, and frees the slot when each is done', async () => {
      await harness.stop();
      harness = await startHarness({ maxVideoUploads: 1 });
      cookie = await harness.signIn();
      // One after another always works, so each upload gives its slot back.
      await uploadVideo();
      await uploadVideo();
      const refusedInvalid = await fetch(`${harness.url}/api/admin/videos`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'video/mp4' },
        body: new Uint8Array(PLAIN),
      });
      expect(refusedInvalid.status).toBe(400);
      await uploadVideo();

      await harness.stop();
      harness = await startHarness({ maxVideoUploads: 0 });
      cookie = await harness.signIn();
      const busy = await fetch(`${harness.url}/api/admin/videos`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'video/mp4' },
        body: new Uint8Array(phoneVideo()),
      });
      expect(busy.status).toBe(503);
      expect(await busy.json()).toEqual({ error: 'busy' });
    });

    it('refuses something that is not an MP4 or MOV', async () => {
      const response = await fetch(`${harness.url}/api/admin/videos`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'video/mp4' },
        body: new Uint8Array(PLAIN),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'not_a_video' });
    });

    it('only takes a poster for a video that exists', async () => {
      expect((await putStill(SOME_IMAGE_ID, 'full')).status).toBe(404);
      expect((await putStill(`v${SOME_IMAGE_ID}`, 'full')).status).toBe(404);
      const photo = await upload();
      expect((await putStill(photo, 'full')).status).toBe(404);
    });

    it("never replaces a video's poster once it's there", async () => {
      const id = await addVideo();
      expect((await putStill(id, 'full')).status).toBe(200);
      expect((await putStill(id, 'full', WITH_GPS)).status).toBe(409);
      expect((await putStill(id, 'small', WITH_GPS)).status).toBe(409);
    });

    it('needs its poster before a game can start', async () => {
      const id = await uploadVideo();
      const deck = await create(withPhoto(id));
      const early = await api('/api/admin/rooms', 'POST', { deckId: deck.id });
      expect(early.status).toBe(409);
      expect((await putStill(id, 'full')).status).toBe(200);
      expect((await api('/api/admin/rooms', 'POST', { deckId: deck.id })).status).toBe(200);
    });

    it('is removed with its deck', async () => {
      const id = await addVideo();
      const deck = await create(withPhoto(id));
      await api(`/api/admin/decks/${deck.id}`, 'DELETE');
      expect((await fetch(`${harness.url}/media/${id}/video.mp4`)).status).toBe(404);
      expect(await harness.app.storage.list(`images/${id}/`)).toEqual([]);
    });

    it('finds nothing for a photo asked for as a video', async () => {
      const photo = await upload();
      expect((await fetch(`${harness.url}/media/${photo}/video.mp4`)).status).toBe(404);
    });
  });

  describe('deleting', () => {
    it('removes the deck and its photos', async () => {
      const image = await upload();
      const deck = await create(withPhoto(image));
      expect((await api(`/api/admin/decks/${deck.id}`, 'DELETE')).status).toBe(200);
      expect((await api(`/api/admin/decks/${deck.id}`)).status).toBe(404);
      expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(404);
    });

    it('keeps a photo another deck still uses', async () => {
      const image = await upload();
      const deck = await create(withPhoto(image));
      await api(`/api/admin/decks/${deck.id}/duplicate`, 'POST');
      await api(`/api/admin/decks/${deck.id}`, 'DELETE');
      expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(200);
    });

    it('keeps a photo a live game is using', async () => {
      const image = await upload();
      const deck = await create(withPhoto(image));
      expect((await api('/api/admin/rooms', 'POST', { deckId: deck.id })).status).toBe(200);
      await api(`/api/admin/decks/${deck.id}`, 'DELETE');
      expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(200);
    });
  });

  describe('deleting a game', () => {
    async function startRoom(content: DeckContent = sampleDeckWithOneWord()): Promise<string> {
      const deck = await create(content);
      const response = await api('/api/admin/rooms', 'POST', { deckId: deck.id });
      expect(response.status).toBe(200);
      return ((await response.json()) as { id: string }).id;
    }

    it('ends it for the TV and every phone, and forgets it', async () => {
      const id = await startRoom();
      const host = await harness.host(id, cookie);
      const joined = await harness.guest(id);
      await send(joined, 'guest:join', { token: newToken(), name: 'Alex' });
      // Still on the name form, so not in any player channel yet.
      const watching = await harness.guest(id);
      const told = [host, joined, watching].map((socket) => nextEvent<string>(socket, 'kicked'));
      const gone = [host, joined, watching].map((socket) => nextEvent<string>(socket, 'disconnect'));

      expect((await api(`/api/admin/rooms/${id}`, 'DELETE')).status).toBe(200);
      expect(await Promise.all(told)).toEqual(['ended', 'ended', 'ended']);
      await Promise.all(gone);

      expect(harness.app.rooms.get(id)).toBeUndefined();
      const list = (await (await api('/api/admin/rooms')).json()) as { rooms: { id: string }[] };
      expect(list.rooms.map((room) => room.id)).not.toContain(id);
      await expect(harness.guest(id)).rejects.toThrow('room_missing');
    });

    it("doesn't come back after a restart", async () => {
      const id = await startRoom();
      await api(`/api/admin/rooms/${id}`, 'DELETE');
      expect(await harness.app.storage.list('rooms/')).toEqual([]);
      await harness.restart();
      expect(harness.app.rooms.get(id)).toBeUndefined();
    });

    it('keeps the deck, so it can be played again', async () => {
      const deck = await create(sampleDeckWithOneWord());
      const { id } = (await (await api('/api/admin/rooms', 'POST', { deckId: deck.id })).json()) as { id: string };
      await api(`/api/admin/rooms/${id}`, 'DELETE');
      expect((await api(`/api/admin/decks/${deck.id}`)).status).toBe(200);
    });

    it('keeps photos its deck still uses', async () => {
      const image = await upload();
      const id = await startRoom(withPhoto(image));
      await api(`/api/admin/rooms/${id}`, 'DELETE');
      expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(200);
    });

    it('removes photos that only it was keeping, once their deck is gone', async () => {
      const image = await upload();
      const deck = await create(withPhoto(image));
      const { id } = (await (await api('/api/admin/rooms', 'POST', { deckId: deck.id })).json()) as { id: string };
      await api(`/api/admin/decks/${deck.id}`, 'DELETE');
      await api(`/api/admin/rooms/${id}`, 'DELETE');
      expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(404);
    });

    it('finds nothing for an unknown or malformed game', async () => {
      expect((await api(`/api/admin/rooms/${'c'.repeat(22)}`, 'DELETE')).status).toBe(404);
      expect((await api('/api/admin/rooms/..%2F..%2Fx', 'DELETE')).status).toBe(404);
      const id = await startRoom();
      expect((await api(`/api/admin/rooms/${id}`, 'DELETE')).status).toBe(200);
      expect((await api(`/api/admin/rooms/${id}`, 'DELETE')).status).toBe(404);
    });
  });

  describe('the sample deck', () => {
    async function addSample(): Promise<StoredDeck> {
      const response = await api('/api/admin/decks/sample', 'POST');
      expect(response.status).toBe(200);
      return ((await response.json()) as { deck: StoredDeck }).deck;
    }

    it('has all four games, ready to play, with its photos on this server', async () => {
      const deck = await addSample();
      expect(deck.content.title).toBe('Sample deck');
      expect(deck.content.games.map((game) => [game.type, game.items.length])).toEqual([
        ['define', 3],
        ['geo', 3],
        ['caption', 2],
        ['choice', 2],
      ]);
      expect(deckProblems(deck.content)).toEqual([]);

      for (const image of imagesInDeck(deck.content)) {
        for (const file of ['full.jpg', 'small.jpg']) {
          const photo = await fetch(`${harness.url}/media/${image}/${file}`);
          expect(photo.status).toBe(200);
          // A served file, not the fallback a phone gets while its own copy is missing.
          expect(photo.headers.get('cache-control')).toContain('immutable');
          const body = Buffer.from(await photo.arrayBuffer());
          expect(cleanJpeg(body)?.body.length).toBe(body.length);
        }
      }
      expect((await api('/api/admin/rooms', 'POST', { deckId: deck.id })).status).toBe(200);
    });

    it('gives each copy its own photos, so deleting one leaves the other playable', async () => {
      const first = await addSample();
      const second = await addSample();
      const kept = imagesInDeck(second.content);
      expect(kept.some((image) => imagesInDeck(first.content).includes(image))).toBe(false);

      await api(`/api/admin/decks/${first.id}`, 'DELETE');
      for (const image of imagesInDeck(first.content)) {
        expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(404);
      }
      expect((await api('/api/admin/rooms', 'POST', { deckId: second.id })).status).toBe(200);
    });
  });

  describe('starting a game from a deck', () => {
    async function start(content: DeckContent) {
      const deck = await create(content);
      return api('/api/admin/rooms', 'POST', { deckId: deck.id });
    }

    it('refuses an unfinished deck and says what is missing', async () => {
      const response = await start({
        ...emptyDeck(),
        games: [{ type: 'define', settings: {}, items: [{ word: 'komorebi', definition: '' }] }],
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'not_ready',
        problems: ['Define it, word 1: add the real definition.'],
      });
    });

    it('refuses a photo this server does not have, as from a deck imported elsewhere', async () => {
      const response = await start(withPhoto(SOME_IMAGE_ID));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { problems: string[] }).problems).toEqual([
        "1 photo in this deck isn't on this server. Remove it or add it again.",
      ]);
    });

    it('refuses a deck that does not exist, and a malformed request', async () => {
      expect((await api('/api/admin/rooms', 'POST', { deckId: SOME_DECK_ID })).status).toBe(404);
      expect((await api('/api/admin/rooms', 'POST', { deckId: '../../x' })).status).toBe(400);
      expect((await api('/api/admin/rooms', 'POST', { deckId: SOME_DECK_ID, extra: 1 })).status).toBe(400);
    });

    it("plays the deck's words with its title, timers and accent", async () => {
      const response = await start({
        ...emptyDeck(),
        title: 'Italy 2027',
        theme: { accent: '#225577' },
        games: [
          {
            type: 'define',
            settings: { writeSeconds: 30, voteSeconds: 20 },
            items: [{ word: 'passeggiata', definition: 'A slow evening walk through town' }],
          },
        ],
      });
      const { id } = (await response.json()) as { id: string };
      const host = await harness.host(id);
      const first = (await hostHello(host)).view as HostView;
      expect(first.title).toBe('Italy 2027');
      expect(first.accent?.light).toBe('#225577');

      const guest = await harness.guest(id);
      await send(guest, 'guest:join', { token: newToken(), name: 'Alex' });
      await command(host, { type: 'next', screenId: 0 });
      await command(host, { type: 'next', screenId: 1 });
      const writing = (await hostHello(host)).view as HostView;
      expect(writing.screen).toMatchObject({ kind: 'write', round: { prompt: 'passeggiata', game: 'define' } });
      expect((writing.screen as { timer: { totalMs: number } }).timer.totalMs).toBe(30_000);
    });

    it('labels a game as finished once it reaches the end', async () => {
      const { id } = (await (await start(sampleDeckWithOneWord())).json()) as { id: string };
      const list = async () =>
        ((await (await api('/api/admin/rooms')).json()) as { rooms: { id: string; finished: boolean }[] }).rooms.find(
          (room) => room.id === id,
        );
      expect((await list())?.finished).toBe(false);

      const host = await harness.host(id);
      const guest = await harness.guest(id);
      await send(guest, 'guest:join', { token: newToken(), name: 'Alex' });
      const room = harness.app.rooms.get(id)!;
      await command(host, { type: 'next', screenId: room.screenId }); // Lobby to title
      await command(host, { type: 'next', screenId: room.screenId }); // Title to writing
      await command(host, { type: 'skipTimer', screenId: room.screenId }); // Time's up
      await command(host, { type: 'skipTimer', screenId: room.screenId }); // Nobody wrote, so on to the reveal
      await command(host, { type: 'next', screenId: room.screenId }); // Reveal to standings
      await command(host, { type: 'next', screenId: room.screenId }); // Standings to final
      expect(((await hostHello(host)).view as HostView).screen.kind).toBe('final');
      expect((await list())?.finished).toBe(true);
    });

    it("never sends the deck's real answer to a guest or the TV while they're writing", async () => {
      const secret = 'A slow evening walk through town';
      const response = await start({
        ...emptyDeck(),
        games: [{ type: 'define', settings: {}, items: [{ word: 'passeggiata', definition: secret }] }],
      });
      const { id } = (await response.json()) as { id: string };
      const host = await harness.host(id);
      const seen: unknown[] = [];
      host.on('view', (view) => seen.push(view));

      const guest = await harness.guest(id);
      guest.on('view', (view) => seen.push(view));
      const token = newToken();
      await send(guest, 'guest:join', { token, name: 'Alex' });

      await command(host, { type: 'next', screenId: 0 });
      await command(host, { type: 'next', screenId: 1 });
      seen.push((await hostHello(host)).view);
      const hello = await send<{ view: GuestView }>(guest, 'guest:hello', { token });
      seen.push(hello.view);
      expect(hello.view.screen.kind).toBe('write');
      expect(JSON.stringify(seen)).toContain('passeggiata');
      expect(JSON.stringify(seen)).not.toContain(secret);
    });
  });
});
