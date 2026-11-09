import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { emptyDeck, type DeckContent } from '../../shared/deck.js';
import type { GuestView, HostView } from '../../shared/protocol.js';
import { command, hostHello, newToken, send, startHarness, type Harness } from './helpers.js';

const PLAIN = readFileSync('tests/fixtures/plain.jpg');
const KYOTO = { lat: 35.0116, lng: 135.7681 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };

interface Guest {
  name: string;
  socket: Socket;
  token: string;
  seq: number;
  seen: unknown[];
}

describe('playing Where was this? from a deck', () => {
  let harness: Harness;
  let cookie: string;
  let roomId: string;
  let host: Socket;
  let tvSeen: unknown[];

  async function post(path: string, body?: unknown, expected = 200) {
    const response = await fetch(`${harness.url}${path}`, {
      method: 'POST',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(expected);
    return (await response.json()) as any;
  }

  async function upload(): Promise<string> {
    const response = await fetch(`${harness.url}/api/admin/images`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array(PLAIN),
    });
    return ((await response.json()) as { id: string }).id;
  }

  function deck(items: DeckContent['games'][number]['items'], settings = {}): DeckContent {
    return { ...emptyDeck(), title: 'Places', games: [{ type: 'geo', settings, items } as DeckContent['games'][number]] };
  }

  beforeEach(async () => {
    harness = await startHarness({ tickMs: 5 });
    cookie = await harness.signIn();
    const image = await upload();
    const created = await post(
      '/api/admin/decks',
      deck([{ image, label: 'Fushimi Inari', ...KYOTO }], { maxPoints: 2000 }),
    );
    roomId = (await post('/api/admin/rooms', { deckId: created.deck.id })).id;
    host = await harness.host(roomId, cookie);
    tvSeen = [];
    host.on('view', (view) => tvSeen.push(view));
  });

  afterEach(() => harness.stop());

  const room = () => harness.app.rooms.get(roomId)!;
  const tv = async (): Promise<HostView> => (await hostHello(host)).view;
  const next = () => command(host, { type: 'next', screenId: room().screenId });
  const skip = () => command(host, { type: 'skipTimer', screenId: room().screenId });

  async function join(name: string): Promise<Guest> {
    const socket = await harness.guest(roomId);
    const token = newToken();
    const seen: unknown[] = [];
    socket.on('view', (view) => seen.push(view));
    const reply = await send<{ ok: boolean; view: GuestView }>(socket, 'guest:join', { token, name });
    seen.push(reply);
    expect(reply.ok).toBe(true);
    return { name, socket, token, seq: 0, seen };
  }

  async function view(guest: Guest): Promise<GuestView> {
    const reply = await send<{ view: GuestView }>(guest.socket, 'guest:hello', { token: guest.token });
    return reply.view;
  }

  function pin(guest: Guest, spot: { lat: number; lng: number }) {
    guest.seq += 1;
    return send<{ ok: boolean; code?: string; view: GuestView }>(guest.socket, 'guest:pin', {
      screenId: room().screenId,
      seq: guest.seq,
      ...spot,
    });
  }

  async function toGuessing(): Promise<void> {
    await next();
    await next();
    expect((await tv()).screen.kind).toBe('guess');
  }

  it('plays through to a score, with the closest guess first', async () => {
    const close = await join('Close');
    const far = await join('Far');
    await toGuessing();
    expect((await pin(close, KYOTO)).ok).toBe(true);
    expect((await pin(far, TOKYO)).ok).toBe(true);
    expect((await view(close)).screen).toMatchObject({ kind: 'guess', pin: KYOTO });

    await skip();
    await skip();
    const screen = (await tv()).screen;
    if (screen.kind !== 'pinReveal') throw new Error(`expected the reveal, got ${screen.kind}`);
    expect(screen.target).toEqual({ ...KYOTO, label: 'Fushimi Inari' });
    expect(screen.pins.map((row) => row.name)).toEqual(['Close', 'Far']);
    expect(screen.pins[0]).toMatchObject({ km: 0, points: 2000 });
    expect(screen.pins[1]!.km).toBeGreaterThan(300);
    expect(screen.pins[1]!.km).toBeLessThan(400);

    const result = (await view(far)).screen;
    if (result.kind !== 'pinReveal') throw new Error(`expected the reveal, got ${result.kind}`);
    expect(result.place).toBe('Fushimi Inari');
    expect(result.result.rank).toBe(2);
    expect(result.result.points).toBe(screen.pins[1]!.points);
  });

  it('never sends the real spot or another guest\'s pin before the reveal', async () => {
    const alex = await join('Alex');
    const sam = await join('Sam');
    await toGuessing();
    await pin(alex, TOKYO);
    await pin(sam, { lat: 43.0618, lng: 141.3545 });
    const before = JSON.stringify([tvSeen, alex.seen, sam.seen, await tv(), await view(alex)]);
    for (const secret of ['Fushimi', '135.76', '35.011']) expect(before).not.toContain(secret);
    // Sam's pin never reaches Alex or the TV, and Alex's never reaches Sam.
    expect(JSON.stringify([tvSeen, alex.seen])).not.toContain('141.35');
    expect(JSON.stringify([tvSeen, sam.seen])).not.toContain('139.76');
  });

  it('refuses a pin outside the country, however it was sent', async () => {
    const guest = await join('Alex');
    await toGuessing();
    for (const spot of [
      { lat: 41.9, lng: 12.5 },
      { lat: 37.56, lng: 126.97 },
      { lat: 36, lng: 145 },
    ]) {
      const reply = await pin(guest, spot);
      expect(reply).toMatchObject({ ok: false, code: 'outside_country' });
    }
    expect((await view(guest)).screen).toMatchObject({ kind: 'guess', pin: null });
    expect((await tv()).screen).toMatchObject({ doneIds: [] });
  });

  it.each([
    ['too far north', { lat: 91, lng: 0 }],
    ['too far west', { lat: 0, lng: -181 }],
    ['not numbers', { lat: '35', lng: '139' }],
    ['not a real number', { lat: null, lng: 139 }],
    ['an extra field', { lat: 35, lng: 139, points: 1000 }],
    ['missing a coordinate', { lat: 35 }],
  ])('refuses a malformed pin: %s', async (_name, body) => {
    const guest = await join('Alex');
    await toGuessing();
    const reply = await send<{ ok: boolean; code: string }>(guest.socket, 'guest:pin', {
      screenId: room().screenId,
      seq: 1,
      ...body,
    });
    expect(reply).toEqual({ ok: false, code: 'bad_request' });
  });

  it('refuses a pin before the round or after it', async () => {
    const guest = await join('Alex');
    expect(await pin(guest, KYOTO)).toMatchObject({ ok: false, code: 'too_late' });
    await toGuessing();
    await skip();
    await skip();
    expect((await tv()).screen.kind).toBe('pinReveal');
    expect(await pin(guest, KYOTO)).toMatchObject({ ok: false, code: 'too_late' });
  });

  it('counts a repeated message once, and ignores an old one', async () => {
    const guest = await join('Alex');
    await toGuessing();
    const screenId = room().screenId;
    const place = (seq: number, spot: typeof KYOTO) =>
      send<{ ok: boolean; code?: string }>(guest.socket, 'guest:pin', { screenId, seq, ...spot });
    expect((await place(5, TOKYO)).ok).toBe(true);
    expect((await place(5, KYOTO)).ok).toBe(true);
    expect((await view(guest)).screen).toMatchObject({ pin: TOKYO });
    expect(await place(4, KYOTO)).toMatchObject({ ok: false, code: 'stale_action' });
    expect((await view(guest)).screen).toMatchObject({ pin: TOKYO, lastSeq: 5 });
  });

  it('lets a guest move their pin until time runs out', async () => {
    const guest = await join('Alex');
    await toGuessing();
    await pin(guest, TOKYO);
    await pin(guest, KYOTO);
    await skip();
    await skip();
    const screen = (await tv()).screen;
    if (screen.kind !== 'pinReveal') throw new Error('expected the reveal');
    expect(screen.pins).toHaveLength(1);
    expect(screen.pins[0]!.km).toBe(0);
  });

  it('has guests rejoin with their pin in place', async () => {
    const guest = await join('Alex');
    await toGuessing();
    await pin(guest, TOKYO);
    guest.socket.disconnect();
    const socket = await harness.guest(roomId);
    const reply = await send<{ view: GuestView }>(socket, 'guest:hello', { token: guest.token });
    expect(reply.view.screen).toMatchObject({ kind: 'guess', pin: TOKYO });
  });

  it('keeps pins and scores through a server restart', async () => {
    const guest = await join('Alex');
    await toGuessing();
    await pin(guest, KYOTO);
    await skip();
    await skip();
    await harness.restart();
    const socket = await harness.guest(roomId);
    const reply = await send<{ view: GuestView }>(socket, 'guest:hello', { token: guest.token });
    expect(reply.view.screen).toMatchObject({ kind: 'pinReveal', result: { points: 2000, total: 2000 } });
  });

  it('refuses to start a deck whose location is out at sea', async () => {
    const image = await upload();
    const created = await post(
      '/api/admin/decks',
      // Inside the box around Japan, but nobody could put a pin there.
      deck([{ image, label: 'Mid-ocean', lat: 36, lng: 145 }]),
    );
    const refused = await post('/api/admin/rooms', { deckId: created.deck.id }, 409);
    expect(refused.problems.join(' ')).toContain('too far from Japan');
  });
});
