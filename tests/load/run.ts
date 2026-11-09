/**
 * Load test: a TV and a room full of simulated guests play a whole short game against a
 * running server, then it reports response times and how hard the server worked.
 *
 *   LOAD_ADMIN_PASSWORD=... npm run test:load -- --url https://<host> [--guests 50]
 *
 * It creates a "Load test" deck with two photos, plays it, and deletes the deck afterwards.
 * It exits with 1 if anything was too slow or went wrong.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { io as connect, type Socket } from 'socket.io-client';
import { emptyDeck, type DeckContent } from '../../shared/deck.js';
import type { GuestView, HostView } from '../../shared/protocol.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.LOAD_URL ?? 'http://localhost:3000' },
    guests: { type: 'string', default: '50' },
    // Leaves the deck in place, to look at afterwards.
    keep: { type: 'boolean', default: false },
    // Lets answers be shown one at a time at their full pace, as on the night, instead of skipping.
    'real-pace': { type: 'boolean', default: false },
  },
});

const URL_BASE = args.url!.replace(/\/$/, '');
const GUESTS = Number(args.guests);
const PASSWORD = process.env.LOAD_ADMIN_PASSWORD;
const PHOTO = readFileSync(new URL('../fixtures/plain.jpg', import.meta.url));
// A few guests use long polling, as phones on networks that block WebSockets do.
const POLLING_EVERY = 10;
// A few guests drop out during the first round and come back, as locked phones do.
const DROPOUT_EVERY = 8;

const LIMITS = {
  replyP95Ms: 300,
  replyMaxMs: 2000,
  spreadP95Ms: 500,
  loopDelayMaxMs: 250,
};

if (!PASSWORD) {
  console.error('Set LOAD_ADMIN_PASSWORD to the presenter password of the server under test.');
  process.exit(2);
}
if (!Number.isInteger(GUESTS) || GUESTS < 2 || GUESTS > 50) {
  console.error('--guests must be a whole number from 2 to 50.');
  process.exit(2);
}

// --- Recording -------------------------------------------------------------

const replyTimes = new Map<string, number[]>();
const failures = new Map<string, number>();
const problems: string[] = [];
const lateNotes: string[] = [];
let tvLatest: HostView | null = null;
/** When the TV first saw each screen, and how long after that each phone saw it. */
const tvSawScreen = new Map<number, number>();
const spread: number[] = [];
const stats: Stats[] = [];

interface Stats {
  cpuPercent: number;
  rssMb: number;
  heapMb: number;
  loopDelayMs: { p50: number; p99: number; max: number };
  connections: number;
}

function count(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function ask<T = any>(socket: Socket, event: string, payload: unknown = {}): Promise<T> {
  const started = performance.now();
  const reply = await socket.timeout(10_000).emitWithAck(event, payload);
  const took = performance.now() - started;
  if (!replyTimes.has(event)) replyTimes.set(event, []);
  replyTimes.get(event)!.push(took);
  if (reply && reply.ok === false) count(failures, `${event}: ${reply.code}`);
  return reply as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const between = (low: number, high: number) => low + Math.random() * (high - low);

// --- Admin side ---------------------------------------------------------------

async function signIn(): Promise<string> {
  const response = await fetch(`${URL_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = response.headers.get('set-cookie');
  if (!response.ok || !cookie) throw new Error(`Sign-in failed with ${response.status}.`);
  return cookie.split(';')[0]!;
}

async function admin<T = any>(cookie: string, method: string, path: string, body?: unknown): Promise<T> {
  const binary = body instanceof Uint8Array;
  const response = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': binary ? 'image/jpeg' : 'application/json' }),
    },
    body: body === undefined ? undefined : binary ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

function loadDeck(geoPhoto: string, captionPhoto: string): DeckContent {
  const deck = emptyDeck();
  return {
    ...deck,
    title: 'Load test',
    games: [
      {
        type: 'define',
        settings: { writeSeconds: 20, voteSeconds: 15 },
        items: [{ word: 'komorebi', definition: 'Sunlight filtering through the leaves of trees' }],
      },
      { type: 'geo', settings: { guessSeconds: 15 }, items: [{ image: geoPhoto, label: 'Fushimi Inari', lat: 34.9671, lng: 135.7727 }] },
      { type: 'caption', settings: { writeSeconds: 20, voteSeconds: 15 }, items: [{ image: captionPhoto }] },
    ],
  } as DeckContent;
}

// --- Guests -------------------------------------------------------------------

const WORDS = [
  'quiet', 'lantern', 'river', 'ancient', 'noodle', 'thunder', 'paper', 'velvet', 'mountain', 'clumsy',
  'shrine', 'whisper', 'copper', 'festival', 'umbrella', 'sleepy', 'moss', 'train', 'pickle', 'kettle',
  'winter', 'firefly', 'bamboo', 'cloud', 'sandal', 'violet', 'harbour', 'crane', 'tofu', 'gravel',
  'blossom', 'dusty', 'ferry', 'ginger', 'heron', 'island', 'jelly', 'kite', 'ladder', 'meadow',
  'needle', 'orchard', 'pebble', 'quilt', 'radish', 'saddle', 'teapot', 'urchin', 'valley', 'walnut',
];
const CITIES = [
  { lat: 35.6812, lng: 139.7671 },
  { lat: 34.6937, lng: 135.5023 },
  { lat: 35.0116, lng: 135.7681 },
  { lat: 43.0618, lng: 141.3545 },
  { lat: 33.5902, lng: 130.4017 },
  { lat: 34.3853, lng: 132.4553 },
  { lat: 35.1815, lng: 136.9066 },
  { lat: 38.2682, lng: 140.8694 },
];

const phrase = () => Array.from({ length: 5 }, () => pick(WORDS)).join(' ');

class Guest {
  socket!: Socket;
  readonly token = randomBytes(32).toString('base64url');
  seq = 0;
  offset = 0;
  view: GuestView | null = null;
  final: GuestView['screen'] | null = null;
  private acted = new Set<string>();
  private droppedOut = false;

  constructor(
    readonly name: string,
    readonly room: string,
    readonly polling: boolean,
    readonly dropsOut: boolean,
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = connect(URL_BASE, {
        auth: { room: this.room, role: 'guest' },
        transports: this.polling ? ['polling'] : ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      this.socket.on('view', (view: GuestView) => this.see(view));
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }

  async join(): Promise<void> {
    await this.open();
    const sync = await ask<{ now: number }>(this.socket, 'time:sync');
    this.offset = sync.now - Date.now();
    const reply = await ask<{ ok: boolean; status?: string; code?: string; view?: GuestView }>(this.socket, 'guest:join', {
      token: this.token,
      name: this.name,
    });
    if (!reply.ok || reply.status !== 'joined') throw new Error(`${this.name} couldn't join: ${reply.code ?? reply.status}`);
    this.see(reply.view!);
  }

  /** Closes the connection, waits as a locked phone might, then comes back with the saved token. */
  async dropOutAndReturn(): Promise<void> {
    this.droppedOut = true;
    this.socket.close();
    await sleep(between(2000, 5000));
    await this.open();
    const reply = await ask<{ ok: boolean; status?: string; view?: GuestView }>(this.socket, 'guest:hello', { token: this.token });
    if (!reply.ok || reply.status !== 'joined') problems.push(`${this.name} couldn't get back in after dropping out.`);
    else this.see(reply.view!);
  }

  private see(view: GuestView): void {
    if (this.view && view.version < this.view.version) return;
    const first = this.view?.screenId !== view.screenId;
    this.view = view;
    if (first) {
      const tvAt = tvSawScreen.get(view.screenId);
      if (tvAt !== undefined) spread.push(performance.now() - tvAt);
    }
    if (view.screen.kind === 'final') this.final = view.screen;
    void this.act(view).catch((error) => problems.push(`${this.name}: ${(error as Error).message}`));
  }

  /** Waits a human-ish while into the time left, so answers arrive spread out. */
  private async think(endsAt: number): Promise<void> {
    // Measured again each time, as phones do every 30 seconds, since this machine's clock can
    // be corrected mid-game. The server keeps its own steady clock, so it doesn't follow.
    const sentAt = Date.now();
    const sync = await ask<{ now: number }>(this.socket, 'time:sync');
    this.offset = sync.now - (sentAt + Date.now()) / 2;
    const left = endsAt - (Date.now() + this.offset);
    await sleep(Math.max(200, between(0.1, 0.6) * left));
  }

  private async act(view: GuestView): Promise<void> {
    const screen = view.screen;
    const key = `${view.screenId}:${screen.kind}`;
    if (this.acted.has(key)) return;
    if (screen.kind === 'write' && screen.answer === null) {
      this.acted.add(key);
      await this.think(screen.timer.endsAt);
      if (this.dropsOut && !this.droppedOut) await this.dropOutAndReturn();
      for (let tries = 0; tries < 3; tries += 1) {
        this.seq += 1;
        const reply = await ask(this.socket, 'guest:answer', { screenId: view.screenId, seq: this.seq, text: phrase() });
        this.noteLate(reply, screen.timer.endsAt);
        if (reply.ok || !['too_similar', 'too_soon'].includes(reply.code)) break;
        await sleep(1500);
      }
    } else if (screen.kind === 'vote' && screen.vote === null && screen.options.length > 0) {
      this.acted.add(key);
      await this.think(screen.timer.endsAt);
      this.seq += 1;
      await ask(this.socket, 'guest:vote', { screenId: view.screenId, seq: this.seq, entryId: pick(screen.options).id });
      // Some change their minds.
      if (Math.random() < 0.2 && screen.options.length > 1) {
        await sleep(between(300, 1500));
        this.seq += 1;
        await ask(this.socket, 'guest:vote', { screenId: view.screenId, seq: this.seq, entryId: pick(screen.options).id });
      }
    } else if (screen.kind === 'guess' && screen.pin === null) {
      this.acted.add(key);
      await this.think(screen.timer.endsAt);
      const city = pick(CITIES);
      this.seq += 1;
      const reply = await ask(this.socket, 'guest:pin', {
        screenId: view.screenId,
        seq: this.seq,
        lat: city.lat + between(-0.05, 0.05),
        lng: city.lng + between(-0.05, 0.05),
      });
      this.noteLate(reply, screen.timer.endsAt);
    }
  }

  /** Says who was turned away as late, and by how much, so a pattern shows. */
  private noteLate(reply: { ok: boolean; code?: string; view?: GuestView }, firstEndsAt: number): void {
    if (reply.ok || reply.code !== 'too_late') return;
    const now = Date.now() + this.offset;
    const timer = (reply.view?.screen as { timer?: { endsAt: number } } | undefined)?.timer;
    const kind = this.polling ? 'polling' : this.dropsOut ? 'dropped out' : 'plain';
    const deadline = timer
      ? `deadline now ${Math.round(timer.endsAt - firstEndsAt)} ms from the first`
      : `phone now on ${reply.view?.screen.kind}`;
    const onTv = tvLatest?.players.find((player) => player.name === this.name);
    const presence = onTv ? (onTv.online ? 'online on the TV' : 'offline on the TV') : 'not on the TV';
    lateNotes.push(
      `${this.name} (${kind}, ${presence}): sent ${Math.round(now - firstEndsAt)} ms after the first deadline, ${deadline}`,
    );
  }
}

// --- The TV -----------------------------------------------------------------

async function openTv(room: string, cookie: string): Promise<Socket> {
  const socket = connect(URL_BASE, {
    auth: { room, role: 'host' },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { cookie },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

/** Presses Space whenever the TV can move on, after letting each reveal play. */
async function present(tv: Socket): Promise<HostView> {
  let latest: HostView = (await ask<{ view: HostView }>(tv, 'host:hello')).view;
  const seen = (view: HostView) => {
    if (view.version < latest.version) return;
    latest = view;
    tvLatest = view;
    if (!tvSawScreen.has(view.screenId)) {
      tvSawScreen.set(view.screenId, performance.now());
      const at = ((Date.now() - started) / 1000).toFixed(0).padStart(4);
      if (view.screen.kind !== 'show') process.stdout.write(`  ${at}s  ${view.screen.kind}\n`);
    }
  };
  const started = Date.now();
  tv.on('view', seen);
  tvSawScreen.set(latest.screenId, performance.now());

  while (latest.screen.kind !== 'final') {
    if (Date.now() - started > 20 * 60_000) throw new Error('The game took more than 20 minutes.');
    // Skips the answers being shown one at a time, with S, since that's only reading time.
    if (latest.screen.kind === 'show' && args['real-pace']) {
      await sleep(200);
      continue;
    }
    if (latest.screen.kind === 'show') {
      const showing = latest.screenId;
      await sleep(1500);
      if (latest.screenId === showing && latest.screen.kind === 'show') {
        const reply = await ask(tv, 'host:command', { type: 'skipTimer', screenId: showing });
        if (!reply.ok && reply.code !== 'stale_screen') problems.push(`S on screen ${showing} was refused: ${reply.code}`);
        const until = Date.now() + 3000;
        while (latest.screenId === showing && Date.now() < until) await sleep(20);
      }
      continue;
    }
    if (!latest.canAdvance) {
      await sleep(200);
      continue;
    }
    const screen = latest.screen as { endsAt?: number };
    const sentAt = Date.now();
    const sync = await ask<{ now: number }>(tv, 'time:sync');
    const offset = sync.now - (sentAt + Date.now()) / 2;
    const wait = screen.endsAt ? screen.endsAt - (Date.now() + offset) : 0;
    await sleep(Math.max(800, wait + 300));
    const pressedOn = latest.screenId;
    const reply = await ask(tv, 'host:command', { type: 'next', screenId: pressedOn });
    if (!reply.ok && reply.code !== 'stale_screen') problems.push(`Space on screen ${pressedOn} was refused: ${reply.code}`);
    const until = Date.now() + 5000;
    while (latest.screenId === pressedOn && Date.now() < until) await sleep(50);
  }
  tv.off('view', seen);
  return latest;
}

// --- Run ----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Load test against ${URL_BASE} with ${GUESTS} guests.`);
  const cookie = await signIn();
  const geoPhoto = (await admin<{ id: string }>(cookie, 'POST', '/api/admin/images', new Uint8Array(PHOTO))).id;
  const captionPhoto = (await admin<{ id: string }>(cookie, 'POST', '/api/admin/images', new Uint8Array(PHOTO))).id;
  const { deck } = await admin<{ deck: { id: string } }>(cookie, 'POST', '/api/admin/decks', loadDeck(geoPhoto, captionPhoto));
  const room = (await admin<{ id: string }>(cookie, 'POST', '/api/admin/rooms', { deckId: deck.id })).id;

  const watching = setInterval(() => {
    void admin<Stats>(cookie, 'GET', '/api/admin/stats').then((sample) => stats.push(sample), () => undefined);
  }, 2000);

  const tv = await openTv(room, cookie);
  const guests = Array.from(
    { length: GUESTS },
    (_, index) =>
      new Guest(`Bot ${String(index + 1).padStart(2, '0')}`, room, index % POLLING_EVERY === 0, index % DROPOUT_EVERY === 3),
  );

  // Everyone scans the QR code within a few seconds, as a room does.
  const joinStarted = performance.now();
  await Promise.all(guests.map(async (guest) => {
    await sleep(between(0, 4000));
    await guest.join();
  }));
  console.log(`  ${GUESTS} joined in ${Math.round(performance.now() - joinStarted)} ms`);

  if (GUESTS === 50) {
    const extra = new Guest('Bot 51', room, false, false);
    const refused = await extra.join().then(() => null, (error: Error) => error.message);
    if (!refused?.includes('room_full')) problems.push(`A 51st guest wasn't turned away as the room being full (${refused ?? 'joined'}).`);
    extra.socket.close();
  }

  const final = await present(tv);

  // Joining locks once the game starts.
  const late = new Guest('Latecomer', room, false, false);
  const lateRefusal = await late.join().then(() => null, (error: Error) => error.message);
  if (!lateRefusal || !/join_locked|room_full/.test(lateRefusal)) {
    problems.push(`A guest joining after the start wasn't turned away (${lateRefusal ?? 'joined'}).`);
  }
  late.socket.close();

  // Every phone ends on its own place, matching the TV's standings.
  await sleep(2000);
  const standings = final.screen.kind === 'final' ? [...final.screen.podium, ...final.screen.rows] : [];
  for (const guest of guests) {
    const mine = guest.final as { kind: 'final'; rank: number; score: number } | null;
    if (!mine) {
      problems.push(`${guest.name} never reached the final screen.`);
      continue;
    }
    const row = standings.find((entry) => entry.name === guest.name);
    if (row && (row.rank !== mine.rank || row.score !== mine.score)) {
      problems.push(`${guest.name}'s phone says ${mine.rank} with ${mine.score}, the TV says ${row.rank} with ${row.score}.`);
    }
  }

  clearInterval(watching);
  stats.push(await admin<Stats>(cookie, 'GET', '/api/admin/stats'));
  tv.close();
  for (const guest of guests) guest.socket.close();
  if (!args.keep) await admin(cookie, 'DELETE', `/api/admin/decks/${deck.id}`);

  report();
}

function report(): void {
  console.log('\nReplies (ms)');
  const all: number[] = [];
  for (const [event, times] of [...replyTimes].sort()) {
    all.push(...times);
    console.log(
      `  ${event.padEnd(14)} ${String(times.length).padStart(5)}  p50 ${percentile(times, 50).toFixed(0).padStart(4)}  p95 ${percentile(times, 95).toFixed(0).padStart(4)}  max ${Math.max(...times).toFixed(0).padStart(5)}`,
    );
  }
  console.log(`\nNew screen reaching every phone after the TV (ms): p50 ${percentile(spread, 50).toFixed(0)}  p95 ${percentile(spread, 95).toFixed(0)}  max ${Math.max(0, ...spread).toFixed(0)}`);

  if (stats.length > 0) {
    const peak = (pick: (s: Stats) => number) => Math.max(...stats.map(pick));
    console.log(
      `Server: CPU peak ${peak((s) => s.cpuPercent)}%  memory peak ${peak((s) => s.rssMb)} MB  event loop delay p99 peak ${peak((s) => s.loopDelayMs.p99)} ms, max ${peak((s) => s.loopDelayMs.max)} ms  connections peak ${peak((s) => s.connections)}`,
    );
  }
  if (failures.size > 0) {
    console.log('\nRefused (expected now and then: too_similar, too_soon, stale_screen, too_late)');
    for (const [key, times] of failures) console.log(`  ${key}: ${times}`);
  }

  if (lateNotes.length > 0) {
    console.log('\nTurned away as late');
    for (const note of lateNotes) console.log(`  ${note}`);
  }

  const expected = /: (too_similar|too_soon|stale_screen|too_late|room_full|join_locked)$/;
  for (const [key, times] of failures) if (!expected.test(key)) problems.push(`Unexpected refusal ${key} (${times}).`);
  if (percentile(all, 95) > LIMITS.replyP95Ms) problems.push(`Replies were slow: p95 ${percentile(all, 95).toFixed(0)} ms.`);
  if (Math.max(0, ...all) > LIMITS.replyMaxMs) problems.push(`A reply took ${Math.max(...all).toFixed(0)} ms.`);
  if (percentile(spread, 95) > LIMITS.spreadP95Ms) problems.push(`Screens reached phones slowly: p95 ${percentile(spread, 95).toFixed(0)} ms.`);
  const worstLoop = Math.max(0, ...stats.map((s) => s.loopDelayMs.max));
  if (worstLoop > LIMITS.loopDelayMaxMs) problems.push(`The server stalled for ${worstLoop} ms at worst.`);

  if (problems.length > 0) {
    console.log('\nFailed:');
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nPassed.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
