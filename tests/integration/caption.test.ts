import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { emptyDeck, type DeckContent } from '../../shared/deck.js';
import type { GuestView, HostView } from '../../shared/protocol.js';
import { command, hostHello, newToken, send, startHarness, type Harness } from './helpers.js';

const PLAIN = readFileSync('tests/fixtures/plain.jpg');

interface Guest {
  name: string;
  socket: Socket;
  token: string;
  seq: number;
  seen: unknown[];
}

describe('playing Caption this from a deck', () => {
  let harness: Harness;
  let cookie: string;
  let roomId: string;
  let host: Socket;
  let photos: string[];
  let tvSeen: unknown[];

  beforeEach(async () => {
    harness = await startHarness({ tickMs: 5 });
    cookie = await harness.signIn();
    photos = [await upload(), await upload()];
    const content: DeckContent = {
      ...emptyDeck(),
      title: 'Captions',
      games: [{ type: 'caption', settings: { perVote: 100 }, items: photos.map((image) => ({ image })) }],
    };
    const created = await post('/api/admin/decks', content);
    const started = await post('/api/admin/rooms', { deckId: created.deck.id });
    roomId = started.id;
    host = await harness.host(roomId, cookie);
    tvSeen = [];
    host.on('view', (view) => tvSeen.push(view));
  });

  afterEach(() => harness.stop());

  async function post(path: string, body?: unknown) {
    const response = await fetch(`${harness.url}${path}`, {
      method: 'POST',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as any;
  }

  async function upload(): Promise<string> {
    const response = await fetch(`${harness.url}/api/admin/images`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array(PLAIN),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  }

  const room = () => harness.app.rooms.get(roomId)!;
  const tv = async (): Promise<HostView> => (await hostHello(host)).view;
  const next = () => command(host, { type: 'next', screenId: room().screenId });
  const skip = () => command(host, { type: 'skipTimer', screenId: room().screenId });

  async function toVoting() {
    for (let press = 0; press < 3 && (await tv()).screen.kind !== 'vote'; press += 1) await skip();
    expect((await tv()).screen.kind).toBe('vote');
  }

  async function join(name: string): Promise<Guest> {
    const socket = await harness.guest(roomId);
    const guest: Guest = { name, socket, token: newToken(), seq: 0, seen: [] };
    socket.on('view', (view) => guest.seen.push(view));
    expect((await send(socket, 'guest:join', { token: guest.token, name })).status).toBe('joined');
    return guest;
  }

  async function viewOf(guest: Guest): Promise<GuestView> {
    return (await send(guest.socket, 'guest:hello', { token: guest.token })).view;
  }

  function write(guest: Guest, text: string) {
    guest.seq += 1;
    return send(guest.socket, 'guest:answer', { screenId: room().screenId, seq: guest.seq, text });
  }

  function vote(guest: Guest, entryId: string) {
    guest.seq += 1;
    return send(guest.socket, 'guest:vote', { screenId: room().screenId, seq: guest.seq, entryId });
  }

  async function optionFor(guest: Guest, text: string): Promise<string> {
    const { screen } = await viewOf(guest);
    if (screen.kind !== 'vote') throw new Error(`expected voting, got ${screen.kind}`);
    return screen.options.find((option) => option.text === text)!.id;
  }

  it('plays two photos to the right standings, and keeps photos private until their round', async () => {
    const alex = await join('Alex');
    const sam = await join('Sam');
    const priya = await join('Priya');

    await next(); // Title card
    expect((await tv()).screen).toMatchObject({ kind: 'title', game: 'caption' });
    for (const seen of [tvSeen, alex.seen, sam.seen, priya.seen]) {
      expect(JSON.stringify(seen)).not.toContain(photos[0]);
      expect(JSON.stringify(seen)).not.toContain(photos[1]);
    }

    await next(); // Photo 1
    const first = await tv();
    expect(first.screen).toMatchObject({ kind: 'write', round: { image: photos[0], number: 1, count: 2 } });
    expect((await viewOf(alex)).screen).toMatchObject({ kind: 'write', round: { image: photos[0] } });
    expect(JSON.stringify([tvSeen, alex.seen, await viewOf(alex)])).not.toContain(photos[1]);
    // The photo itself is there for phones, without signing in.
    expect((await fetch(`${harness.url}/media/${photos[0]}/small.jpg`)).status).toBe(200);

    expect((await write(alex, 'A cat judging the entire platform')).ok).toBe(true);
    expect((await write(sam, 'A cat judging the whole entire platform')).code).toBe('too_similar');
    expect((await write(priya, 'Rush hour, as seen by the pigeons')).ok).toBe(true);
    alex.seen.length = 0;
    await skip();
    await skip();

    // The TV reads them out one at a time, and phones get a count but no words.
    const showing = (await tv()).screen;
    if (showing.kind !== 'show') throw new Error(`expected a caption, got ${showing.kind}`);
    expect(showing).toMatchObject({ number: 1, count: 2 });
    expect((await viewOf(alex)).screen).toMatchObject({ kind: 'show', number: 1, count: 2 });
    expect(JSON.stringify(alex.seen)).not.toContain('pigeons');
    expect((await vote(alex, showing.entry.id)).code).toBe('too_late');
    await next();
    expect((await tv()).screen).toMatchObject({ kind: 'show', number: 2 });
    await skip();

    // Each phone's ballot leaves out their own, and voting for it is refused anyway.
    const tvVote = (await tv()).screen;
    if (tvVote.kind !== 'vote') throw new Error(`expected voting, got ${tvVote.kind}`);
    expect(JSON.stringify(tvVote.entries)).not.toMatch(/Alex|Priya/);
    const alexBallot = (await viewOf(alex)).screen;
    if (alexBallot.kind !== 'vote') throw new Error('expected voting');
    expect(alexBallot.options.map((option) => option.text)).toEqual(['Rush hour, as seen by the pigeons']);
    const alexOwn = tvVote.entries.find((entry) => entry.text.startsWith('A cat'))!.id;
    expect((await vote(alex, alexOwn)).code).toBe('own_entry');

    const pigeons = 'Rush hour, as seen by the pigeons';
    expect((await vote(alex, await optionFor(alex, pigeons))).ok).toBe(true);
    expect((await vote(sam, await optionFor(sam, pigeons))).ok).toBe(true);
    expect((await vote(priya, await optionFor(priya, 'A cat judging the entire platform'))).ok).toBe(true);
    await skip();
    await skip();

    const reveal = (await tv()).screen;
    if (reveal.kind !== 'reveal') throw new Error(`expected the reveal, got ${reveal.kind}`);
    expect(reveal.rows.map((row) => [row.author, row.votes, row.top, row.real])).toEqual([
      ['Alex', 1, false, false],
      ['Priya', 2, true, false],
    ]);
    // The deck set 100 per vote, and the top caption still gets the default bonus.
    expect((await viewOf(priya)).screen).toMatchObject({ result: { points: 700, votes: 2, top: true } });
    expect((await viewOf(alex)).screen).toMatchObject({ result: { points: 100, votes: 1, top: false } });
    expect((await viewOf(sam)).screen).toMatchObject({ result: { points: 0, wrote: false } });

    await next(); // Shows the rest of the reveal at once
    await next(); // Photo 2
    expect((await tv()).screen).toMatchObject({ kind: 'write', round: { image: photos[1], number: 2 } });
    await skip();
    await skip();
    await next(); // Nothing to wait for in an empty reveal

    const standings = (await tv()).screen;
    if (standings.kind !== 'standings') throw new Error(`expected standings, got ${standings.kind}`);
    expect(standings.game).toBe('caption');
    expect(standings.rows.map((row) => [row.name, row.score, row.rank])).toEqual([
      ['Priya', 700, 1],
      ['Alex', 100, 2],
      ['Sam', 0, 3],
    ]);
    await next();
    expect((await tv()).screen.kind).toBe('final');
  });

  it('lets the presenter hide a caption, and whoever voted for it votes again', async () => {
    const alex = await join('Alex');
    const sam = await join('Sam');
    const priya = await join('Priya');
    await next();
    await next();
    await write(alex, 'A rude caption');
    await write(sam, 'A polite caption about pigeons');
    await toVoting();
    const rude = await optionFor(priya, 'A rude caption');
    await vote(priya, rude);
    expect((await command(host, { type: 'hideEntry', entryId: rude })).ok).toBe(true);
    const { screen } = await viewOf(priya);
    if (screen.kind !== 'vote') throw new Error('expected voting');
    expect(screen.vote).toBeNull();
    expect(screen.voteCleared).toBe(true);
    expect(screen.options.map((option) => option.text)).toEqual(['A polite caption about pigeons']);
  });

  it('moves through the captions by itself', async () => {
    const created = await post('/api/admin/decks', {
      ...emptyDeck(),
      title: 'Quick',
      games: [{ type: 'caption', settings: { showSeconds: 2 }, items: [{ image: photos[0]! }] }],
    });
    roomId = (await post('/api/admin/rooms', { deckId: created.deck.id })).id;
    host = await harness.host(roomId, cookie);
    const alex = await join('Alex');
    const sam = await join('Sam');
    await next();
    await next();
    await write(alex, 'A cat judging the entire platform');
    await write(sam, 'Rush hour, as seen by the pigeons');
    await skip();
    const showing = (await tv()).screen;
    expect(showing).toMatchObject({ kind: 'show', number: 1, timer: { totalMs: 2000 } });
    room().tick((showing as { timer: { endsAt: number } }).timer.endsAt);
    expect((await tv()).screen).toMatchObject({ kind: 'show', number: 2 });
  });

  it('picks up the same photo after the server restarts', async () => {
    const alex = await join('Alex');
    await next();
    await next();
    await write(alex, 'A cat judging the entire platform');
    await harness.restart();
    const socket = await harness.guest(roomId);
    const { view } = await send(socket, 'guest:hello', { token: alex.token });
    expect(view.screen).toMatchObject({
      kind: 'write',
      answer: 'A cat judging the entire platform',
      round: { image: photos[0] },
    });
    expect((await fetch(`${harness.url}/media/${photos[0]}/full.jpg`)).status).toBe(200);
  });
});
