/**
 * Sample players, for running through a game on your own while developing.
 *
 *   npm run players -- <join link, TV link or room id> [--count 4] [--url http://localhost:3000]
 *
 * Start a game, leave its lobby on the TV, then run this. Each player joins and plays every
 * round like a guest's phone would: writing, voting, dropping pins and picking answers. You
 * press Space on the TV. They leave when the game ends, or on Ctrl+C.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { io as connect, type Socket } from 'socket.io-client';
import { MAX_PLAYERS, ROOM_ID_PATTERN } from '../shared/constants.js';
import type { Country } from '../shared/countries.js';
import { wrapLng } from '../shared/geo.js';
import type { GuestView } from '../shared/protocol.js';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    count: { type: 'string', default: '4' },
    url: { type: 'string' },
  },
});

const NAMES = ['Ada', 'Bashir', 'Chidi', 'Dolores', 'Emeka', 'Freya', 'Goro', 'Hana', 'Imani', 'Jules', 'Kofi', 'Lupe'];
const WORDS = [
  'a quiet', 'lantern', 'river', 'ancient', 'noodle', 'thunder', 'paper', 'velvet', 'mountain', 'clumsy',
  'whisper', 'copper', 'festival', 'umbrella', 'sleepy', 'moss', 'train', 'pickle', 'kettle', 'winter',
  'firefly', 'bamboo', 'cloud', 'sandal', 'violet', 'harbour', 'crane', 'gravel', 'blossom', 'ferry',
];

const target = positionals[0] ?? '';
const room = target.split(/[/?#]/).find((part) => ROOM_ID_PATTERN.test(part));
const linkOrigin = /^https?:\/\//.test(target) ? new URL(target).origin : null;
const base = (args.url ?? linkOrigin ?? 'http://localhost:3000').replace(/\/$/, '');
const count = Number(args.count);

if (!room) {
  console.error('Give the game to join: its join link, its TV link, or the room id from either.');
  process.exit(2);
}
if (!Number.isInteger(count) || count < 1 || count > MAX_PLAYERS) {
  console.error(`--count must be a whole number from 1 to ${MAX_PLAYERS}.`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const between = (low: number, high: number) => low + Math.random() * (high - low);
const phrase = () => Array.from({ length: 4 }, () => pick(WORDS)).join(' ');

interface Reply {
  ok: boolean;
  status?: string;
  code?: string;
  view?: GuestView;
}

class Player {
  private socket!: Socket;
  private readonly token = randomBytes(32).toString('base64url');
  private seq = 0;
  private offset = 0;
  private version = -1;
  private readonly acted = new Set<number>();
  finished = false;

  constructor(readonly name: string) {}

  private ask(event: string, payload: unknown = {}): Promise<Reply & { now?: number }> {
    return this.socket.timeout(10_000).emitWithAck(event, payload);
  }

  async join(): Promise<void> {
    this.socket = connect(base, { auth: { room, role: 'guest' }, transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
    this.socket.on('view', (view: GuestView) => this.see(view));
    // After a dropped connection, comes back as the same player.
    this.socket.on('connect', () => {
      void this.ask('guest:hello', { token: this.token }).then((reply) => reply.view && this.see(reply.view), () => undefined);
    });
    const reply = await this.ask('guest:join', { token: this.token, name: this.name });
    if (!reply.ok || reply.status !== 'joined') throw new Error(`${this.name} couldn't join: ${reply.code ?? reply.status}`);
    this.see(reply.view!);
  }

  leave(): void {
    this.socket?.close();
  }

  private see(view: GuestView): void {
    if (view.version < this.version) return;
    this.version = view.version;
    if (view.screen.kind === 'final') this.finished = true;
    void this.act(view).catch((error: Error) => console.error(`  ${this.name}: ${error.message}`));
  }

  /** Waits a human-ish while into the time left, so answers arrive spread out. */
  private async think(endsAt: number): Promise<void> {
    const sentAt = Date.now();
    const sync = await this.ask('time:sync');
    if (typeof sync.now === 'number') this.offset = sync.now - (sentAt + Date.now()) / 2;
    const left = endsAt - (Date.now() + this.offset);
    await sleep(Math.max(300, Math.min(8000, between(0.1, 0.4) * left)));
  }

  private send(event: string, screenId: number, payload: object): Promise<Reply> {
    this.seq += 1;
    return this.ask(event, { screenId, seq: this.seq, ...payload });
  }

  private async act(view: GuestView): Promise<void> {
    const screen = view.screen;
    if (this.acted.has(view.screenId)) return;
    if (screen.kind === 'write' && screen.answer === null) {
      this.acted.add(view.screenId);
      await this.think(screen.timer.endsAt);
      for (let tries = 0; tries < 3; tries += 1) {
        const reply = await this.send('guest:answer', view.screenId, { text: phrase() });
        if (reply.ok || !['too_similar', 'too_soon'].includes(reply.code ?? '')) break;
        await sleep(1500);
      }
    } else if (screen.kind === 'vote' && screen.vote === null && screen.options.length > 0) {
      this.acted.add(view.screenId);
      await this.think(screen.timer.endsAt);
      await this.send('guest:vote', view.screenId, { entryId: pick(screen.options).id });
    } else if (screen.kind === 'guess' && screen.pin === null) {
      this.acted.add(view.screenId);
      await this.think(screen.timer.endsAt);
      await this.dropPin(view.screenId, view.mapArea);
    } else if (screen.kind === 'pick' && screen.pick === null) {
      this.acted.add(view.screenId);
      await this.think(screen.timer.endsAt);
      await this.send('guest:pick', view.screenId, { option: Math.floor(Math.random() * screen.options.length) });
    }
  }

  /** A pin must land on the deck's country, so a spot in the sea is tried again somewhere else. */
  private async dropPin(screenId: number, area: Country | null): Promise<void> {
    const [west, south, east, north] = area?.box ?? [-10, -10, 10, 10];
    for (let tries = 0; tries < 25; tries += 1) {
      // Starts near the middle, then looks further out.
      const spread = Math.min(1, 0.2 + tries * 0.1);
      const reply = await this.send('guest:pin', screenId, {
        lat: (south + north) / 2 + between(-0.5, 0.5) * (north - south) * spread,
        lng: wrapLng((west + east) / 2 + between(-0.5, 0.5) * (east - west) * spread),
      });
      if (reply.ok || reply.code !== 'outside_country') return;
    }
  }
}

async function main(): Promise<void> {
  const players = Array.from({ length: count }, (_, index) => {
    const name = NAMES[index % NAMES.length]!;
    return new Player(index < NAMES.length ? name : `${name} ${Math.floor(index / NAMES.length) + 1}`);
  });
  for (const player of players) {
    await player.join();
    console.log(`  ${player.name} joined`);
    await sleep(between(200, 600));
  }
  console.log(`${count} sample players are in. Press Space on the TV to start.`);

  process.once('SIGINT', () => {
    for (const player of players) player.leave();
    process.exit(0);
  });
  while (!players.every((player) => player.finished)) await sleep(1000);
  // Long enough for each to see its place land.
  await sleep(15_000);
  for (const player of players) player.leave();
  console.log('The game is over. The sample players have left.');
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
