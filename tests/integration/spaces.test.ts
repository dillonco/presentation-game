import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type DeckContent } from '../../shared/deck.js';
import { startHarness, type Harness } from './helpers.js';
import { io as ioConnect } from 'socket.io-client';
import { phoneVideo } from '../fixtures/mp4.js';

const PHOTO = readFileSync('tests/fixtures/plain.jpg');

describe('hosted spaces', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness({ hosted: true, limits: { decks: 3, media: 3, games: 2 } });
  });

  afterEach(async () => {
    await harness.stop();
  });

  async function newSpace(): Promise<{ cookie: string; code: string }> {
    const response = await fetch(`${harness.url}/api/spaces`, { method: 'POST' });
    expect(response.status).toBe(200);
    const { code } = (await response.json()) as { code: string };
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, code };
  }

  function call(cookie: string, path: string, init: RequestInit = {}) {
    return fetch(`${harness.url}${path}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });
  }

  function send(cookie: string, method: string, path: string, body: unknown) {
    return call(cookie, path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function upload(cookie: string): Promise<Response> {
    return call(cookie, '/api/admin/images', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: PHOTO });
  }

  function captionDeck(image: string): DeckContent {
    return { ...emptyDeck(), games: [{ type: 'caption', settings: {}, items: [{ image }] }] };
  }

  async function deckWith(cookie: string, content: DeckContent): Promise<string> {
    const response = await send(cookie, 'POST', '/api/admin/decks', content);
    expect(response.status).toBe(200);
    return ((await response.json()) as { deck: { id: string } }).deck.id;
  }

  it("never lets the main space's clean-up delete a hosted space's photo", async () => {
    const space = await newSpace();
    const { id } = (await (await upload(space.cookie)).json()) as { id: string };
    await deckWith(space.cookie, captionDeck(id));
    // Whoever runs the server may show any photo, but deleting their deck leaves this one alone.
    const main = await harness.signIn();
    const mainDeck = await deckWith(main, captionDeck(id));
    expect((await call(main, `/api/admin/decks/${mainDeck}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${harness.url}/media/${id}/full.jpg`)).status).toBe(200);
  });

  it("deletes a space's own unused photo, record and all", async () => {
    const space = await newSpace();
    const { id } = (await (await upload(space.cookie)).json()) as { id: string };
    const deck = await deckWith(space.cookie, captionDeck(id));
    expect((await call(space.cookie, `/api/admin/decks/${deck}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${harness.url}/media/${id}/full.jpg`)).status).toBe(404);
    expect(await harness.app.storage.list('owners/')).toEqual([]);
  });

  it('says it is hosted, so the home page can offer codes', async () => {
    expect(await (await fetch(`${harness.url}/api/config`)).json()).toEqual({ hosted: true, passwordSignIn: true });
  });

  it('gives each new space its own 6-letter code and signs its browser in', async () => {
    const one = await newSpace();
    const two = await newSpace();
    expect(one.code).toMatch(/^[A-HJ-NP-Z]{6}$/);
    expect(one.code).not.toBe(two.code);
    expect(await (await call(one.cookie, '/api/admin/me')).json()).toEqual({ signedIn: true });
    const space = (await (await call(one.cookie, '/api/admin/space')).json()) as { space: { code: string } };
    expect(space.space.code).toBe(one.code);
  });

  it("keeps each space's decks to itself", async () => {
    const one = await newSpace();
    const two = await newSpace();
    const id = await deckWith(one.cookie, emptyDeck());
    expect((await call(two.cookie, `/api/admin/decks/${id}`)).status).toBe(404);
    expect((await send(two.cookie, 'PUT', `/api/admin/decks/${id}`, { revision: 1, content: emptyDeck() })).status).toBe(404);
    expect((await call(two.cookie, `/api/admin/decks/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await send(two.cookie, 'POST', '/api/admin/rooms', { deckId: id })).status).toBe(404);
    expect(((await (await call(two.cookie, '/api/admin/decks')).json()) as { decks: unknown[] }).decks).toEqual([]);
    expect(((await (await call(one.cookie, '/api/admin/decks')).json()) as { decks: unknown[] }).decks).toHaveLength(1);
    // The main space, opened with the password, doesn't see hosted decks either.
    const main = await harness.signIn();
    expect((await call(main, `/api/admin/decks/${id}`)).status).toBe(404);
  });

  it("won't let a space use, replace or delete another space's photos", async () => {
    const one = await newSpace();
    const two = await newSpace();
    const { id: image } = (await (await upload(one.cookie)).json()) as { id: string };

    // Guests see photo addresses during a game, so knowing one mustn't be enough.
    expect((await send(two.cookie, 'POST', '/api/admin/decks', captionDeck(image))).status).toBe(403);
    const ownDeck = await deckWith(two.cookie, emptyDeck());
    expect((await send(two.cookie, 'PUT', `/api/admin/decks/${ownDeck}`, { revision: 1, content: captionDeck(image) })).status).toBe(403);
    const replace = await call(two.cookie, `/api/admin/images/${image}/small`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: PHOTO,
    });
    expect(replace.status).toBe(404);

    // The owner can use it, and deleting the other space's deck leaves it alone.
    const deck = await deckWith(one.cookie, captionDeck(image));
    await call(two.cookie, `/api/admin/decks/${ownDeck}`, { method: 'DELETE' });
    expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(200);
    await call(one.cookie, `/api/admin/decks/${deck}`, { method: 'DELETE' });
    expect((await fetch(`${harness.url}/media/${image}/full.jpg`)).status).toBe(404);
  });

  it('runs a game only on its own TV, and guests join it by code', async () => {
    const one = await newSpace();
    const two = await newSpace();
    const room = ((await (await call(one.cookie, '/api/admin/rooms', { method: 'POST' })).json()) as { id: string }).id;

    const host = await harness.host(room, one.cookie);
    const view = (await host.emitWithAck('host:hello', {})) as { view: { joinCode: string } };
    expect(view.view.joinCode).toBe(one.code);
    await expect(harness.host(room, two.cookie)).rejects.toThrow();
    await expect(harness.host(room, await harness.signIn())).rejects.toThrow();

    // Codes work in any case, with spaces.
    const typed = `${one.code.slice(0, 3).toLowerCase()} ${one.code.slice(3)}`;
    expect(await (await fetch(`${harness.url}/api/join/${encodeURIComponent(typed)}`)).json()).toEqual({ room });
    expect((await fetch(`${harness.url}/api/join/${two.code}`)).status).toBe(404);
    expect((await fetch(`${harness.url}/api/join/ZZZ`)).status).toBe(404);

    expect((await call(two.cookie, `/api/admin/rooms/${room}`, { method: 'DELETE' })).status).toBe(404);
    expect(((await (await call(two.cookie, '/api/admin/rooms')).json()) as { rooms: unknown[] }).rooms).toEqual([]);
  });

  it('moves the presenter to another device with the presenter link', async () => {
    const one = await newSpace();
    const { space } = (await (await call(one.cookie, '/api/admin/space')).json()) as { space: { presenterKey: string } };
    const claimed = await send('', 'POST', '/api/spaces/claim', { key: space.presenterKey });
    expect(claimed.status).toBe(200);
    const cookie = claimed.headers.get('set-cookie')!.split(';')[0]!;
    expect(((await (await call(cookie, '/api/admin/space')).json()) as { space: { code: string } }).space.code).toBe(one.code);

    const [id] = space.presenterKey.split('.');
    expect((await send('', 'POST', '/api/spaces/claim', { key: `${id}.wrong` })).status).toBe(404);
    expect((await send('', 'POST', '/api/spaces/claim', { key: 'junk' })).status).toBe(404);
  });

  it('resets the presenter link, signing out every other device but this one', async () => {
    const one = await newSpace();
    const read = async (cookie: string) =>
      ((await (await call(cookie, '/api/admin/space')).json()) as { space: { presenterKey: string } }).space;
    const { presenterKey: oldKey } = await read(one.cookie);
    const other = await send('', 'POST', '/api/spaces/claim', { key: oldKey });
    const otherCookie = other.headers.get('set-cookie')!.split(';')[0]!;
    expect(await (await call(otherCookie, '/api/admin/me')).json()).toEqual({ signedIn: true });

    const reset = await call(one.cookie, '/api/admin/space/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    const { space } = (await reset.json()) as { space: { presenterKey: string } };
    expect(space.presenterKey).not.toBe(oldKey);
    const fresh = reset.headers.get('set-cookie')!.split(';')[0]!;

    // The device that reset it stays in, with its new cookie. Everyone else is out.
    expect(await (await call(fresh, '/api/admin/me')).json()).toEqual({ signedIn: true });
    expect(await (await call(one.cookie, '/api/admin/me')).json()).toEqual({ signedIn: false });
    expect(await (await call(otherCookie, '/api/admin/me')).json()).toEqual({ signedIn: false });
    // The old link no longer works, the new one does.
    expect((await send('', 'POST', '/api/spaces/claim', { key: oldKey })).status).toBe(404);
    expect((await send('', 'POST', '/api/spaces/claim', { key: space.presenterKey })).status).toBe(200);
  });

  it('lets go of TVs connected before the presenter link was reset', async () => {
    const one = await newSpace();
    const started = await call(one.cookie, '/api/admin/rooms', { method: 'POST' });
    const { id: room } = (await started.json()) as { id: string };
    const tv = await harness.host(room, one.cookie);
    const dropped = new Promise((resolve) => tv.once('disconnect', resolve));
    expect((await call(one.cookie, '/api/admin/space/reset', { method: 'POST' })).status).toBe(200);
    expect(await dropped).toBe('io server disconnect');
    // Its old session no longer gets it back in.
    await expect(harness.host(room, one.cookie)).rejects.toThrow('unauthorized');
  });

  it('keeps spaces and their links across a restart', async () => {
    const one = await newSpace();
    const { space } = (await (await call(one.cookie, '/api/admin/space')).json()) as { space: { presenterKey: string } };
    await harness.restart();
    expect(await (await call(one.cookie, '/api/admin/me')).json()).toEqual({ signedIn: true });
    expect((await send('', 'POST', '/api/spaces/claim', { key: space.presenterKey })).status).toBe(200);
  });

  describe('behind a trusted proxy', () => {
    const from = (ip: string) => ({ method: 'POST', headers: { 'x-forwarded-for': ip } });

    it('gives each visitor their own small allowance of new spaces', async () => {
      await harness.stop();
      harness = await startHarness({ hosted: true, trustProxy: 1 });
      for (let i = 0; i < 3; i++) expect((await fetch(`${harness.url}/api/spaces`, from('203.0.113.1'))).status).toBe(200);
      expect((await fetch(`${harness.url}/api/spaces`, from('203.0.113.1'))).status).toBe(429);
      // Someone else isn't held up by them.
      expect((await fetch(`${harness.url}/api/spaces`, from('203.0.113.2'))).status).toBe(200);
      // A made-up address in front of the real one changes nothing.
      expect((await fetch(`${harness.url}/api/spaces`, from('198.51.100.9, 203.0.113.1'))).status).toBe(429);
    });

    it('limits how many connections one address can hold', async () => {
      await harness.stop();
      harness = await startHarness({ hosted: true, trustProxy: 1, maxAddressConnections: 2 });
      const room = await harness.createRoom();
      const connect = (ip: string) =>
        new Promise<void>((resolve, reject) => {
          const socket = ioConnect(harness.url, {
            auth: { room, role: 'guest' },
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            extraHeaders: { 'x-forwarded-for': ip },
          });
          harness.sockets.push(socket);
          socket.once('connect', () => resolve());
          socket.once('connect_error', reject);
        });
      await connect('203.0.113.1');
      await connect('203.0.113.1');
      await expect(connect('203.0.113.1')).rejects.toThrow('slow_down');
      await expect(connect('203.0.113.2')).resolves.toBeUndefined();
    });
  });

  it("applies no per-visitor limit when there's no trusted proxy to say who the visitor is", async () => {
    // Behind an untrusted proxy everyone would look the same, so one allowance each would be one for all.
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${harness.url}/api/spaces`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.1' } });
      expect(response.status).toBe(200);
    }
  });

  it('stops making spaces once the server holds as many as it can', async () => {
    await harness.stop();
    harness = await startHarness({ hosted: true, maxSpaces: 2 });
    await newSpace();
    await newSpace();
    const third = await fetch(`${harness.url}/api/spaces`, { method: 'POST' });
    expect(third.status).toBe(503);
    expect(await third.json()).toEqual({ error: 'full' });
    expect(third.headers.get('set-cookie')).toBeNull();
  });

  it('limits what one space can keep', async () => {
    const one = await newSpace();
    for (let i = 0; i < 3; i++) await deckWith(one.cookie, emptyDeck());
    expect((await send(one.cookie, 'POST', '/api/admin/decks', emptyDeck())).status).toBe(409);

    for (let i = 0; i < 3; i++) expect((await upload(one.cookie)).status).toBe(200);
    expect((await upload(one.cookie)).status).toBe(409);

    // Starting a third game ends the oldest, so a space never holds more than two.
    const start = async () =>
      ((await (await call(one.cookie, '/api/admin/rooms', { method: 'POST' })).json()) as { id: string }).id;
    const first = await start();
    await start();
    await start();
    const rooms = ((await (await call(one.cookie, '/api/admin/rooms')).json()) as { rooms: { id: string }[] }).rooms;
    expect(rooms).toHaveLength(2);
    expect(rooms.map((room) => room.id)).not.toContain(first);
  });

  it('holds fewer videos than photos, since each can be 100 MB', async () => {
    await harness.stop();
    harness = await startHarness({ hosted: true, limits: { decks: 3, media: 10, games: 2, videos: 1 } });
    const one = await newSpace();
    const sendVideo = () =>
      call(one.cookie, '/api/admin/videos', {
        method: 'POST',
        headers: { 'content-type': 'video/mp4' },
        body: new Uint8Array(phoneVideo()),
      });
    expect((await sendVideo()).status).toBe(200);
    const second = await sendVideo();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'too_many_videos' });
    // Photos still fit.
    expect((await upload(one.cookie)).status).toBe(200);
  });

  it('holds the video limit when several arrive at once', async () => {
    await harness.stop();
    harness = await startHarness({ hosted: true, limits: { decks: 3, media: 10, games: 2, videos: 2 } });
    const one = await newSpace();
    const statuses = await Promise.all(
      Array.from({ length: 4 }, async () =>
        (
          await call(one.cookie, '/api/admin/videos', {
            method: 'POST',
            headers: { 'content-type': 'video/mp4' },
            body: new Uint8Array(phoneVideo()),
          })
        ).status,
      ),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(2);
    expect(statuses.filter((status) => status === 409)).toHaveLength(2);
  });

  it('tells phones and clears out photos when the server drops a game by itself', async () => {
    const space = await newSpace();
    const { id: photo } = (await (await upload(space.cookie)).json()) as { id: string };
    const deck = await deckWith(space.cookie, captionDeck(photo));
    const started = await send(space.cookie, 'POST', '/api/admin/rooms', { deckId: deck });
    const { id: room } = (await started.json()) as { id: string };
    // The deck goes first, so only the game is keeping the photo.
    expect((await call(space.cookie, `/api/admin/decks/${deck}`, { method: 'DELETE' })).status).toBe(200);
    const guest = await harness.guest(room);
    const kicked = new Promise((resolve) => guest.once('kicked', resolve));
    harness.app.rooms.get(room)!.updatedAt -= 25 * 60 * 60 * 1000;
    await harness.app.rooms.sweep();
    expect(await kicked).toBe('ended');
    expect((await fetch(`${harness.url}/media/${photo}/full.jpg`)).status).toBe(404);
  });

  it('holds the photo limit when many uploads arrive at once', async () => {
    const one = await newSpace();
    const statuses = await Promise.all(Array.from({ length: 8 }, async () => (await upload(one.cookie)).status));
    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 409)).toHaveLength(5);
    // The sample deck needs room for all its photos.
    expect((await call(one.cookie, '/api/admin/decks/sample', { method: 'POST' })).status).toBe(409);
  });

  it('holds the deck and sample limits when requests arrive at once', async () => {
    const one = await newSpace();
    const decks = await Promise.all(
      Array.from({ length: 6 }, async () => (await send(one.cookie, 'POST', '/api/admin/decks', emptyDeck())).status),
    );
    expect(decks.filter((status) => status === 200)).toHaveLength(3);

  });

  it('fits only as many samples as there is room for, even asked for at once', async () => {
    // Room for one sample's 7 photos, but not two.
    const roomy = await startHarness({ hosted: true, limits: { decks: 20, media: 10, games: 2 } });
    try {
      const response = await fetch(`${roomy.url}/api/spaces`, { method: 'POST' });
      const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      const samples = await Promise.all(
        Array.from({ length: 4 }, async () =>
          (await fetch(`${roomy.url}/api/admin/decks/sample`, { method: 'POST', headers: { cookie } })).status,
        ),
      );
      expect(samples.filter((status) => status === 200)).toHaveLength(1);
    } finally {
      await roomy.stop();
    }
  });

  it("won't make or sign in to a space for another site", async () => {
    const forged = await fetch(`${harness.url}/api/spaces`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(forged.status).toBe(403);
    expect(forged.headers.get('set-cookie')).toBeNull();
    const fetched = await fetch(`${harness.url}/api/spaces`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(fetched.status).toBe(403);
    const login = await fetch(`${harness.url}/api/admin/login`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    expect(login.status).toBe(403);
    // However the path is written.
    for (const path of ['/%61pi/spaces', '//api/spaces', '/api/../api/spaces']) {
      expect((await fetch(`${harness.url}${path}`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    }
    // A neighbouring app on a shared hosting domain counts as the same site, but not the same origin.
    const neighbour = await fetch(`${harness.url}/api/spaces`, { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } });
    expect(neighbour.status).toBe(403);
    // The same site is fine.
    const own = await fetch(`${harness.url}/api/spaces`, { method: 'POST', headers: { origin: harness.url } });
    expect(own.status).toBe(200);
  });

  it("keeps the server's numbers for whoever runs it", async () => {
    const one = await newSpace();
    expect((await call(one.cookie, '/api/admin/stats')).status).toBe(401);
    expect((await call(await harness.signIn(), '/api/admin/stats')).status).toBe(200);
  });
});

describe('a server you run yourself', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it('has no spaces or codes', async () => {
    expect(await (await fetch(`${harness.url}/api/config`)).json()).toEqual({ hosted: false, passwordSignIn: true });
    expect((await fetch(`${harness.url}/api/spaces`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${harness.url}/api/join/ABCDEF`)).status).toBe(404);
    const cookie = await harness.signIn();
    expect(await (await fetch(`${harness.url}/api/admin/space`, { headers: { cookie } })).json()).toEqual({ space: null });
  });
});
