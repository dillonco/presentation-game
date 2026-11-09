import { SAMPLE_WORDS } from '../../shared/deck.js';
import type { Storage } from '../storage/index.js';
import { MAIN_SPACE } from '../spaces.js';
import { randomId, Room, type RoomSetup } from './room.js';
import { TokenBucket } from './rate-limit.js';

const SNAPSHOT_PREFIX = 'rooms/';
const SNAPSHOT_DELAY_MS = 2000;
const RETRY_DELAY_MS = 5000;
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** How long a hosted game nobody has joined keeps its slot once the server is full. */
const UNPLAYED_LIFETIME_MS = 60 * 60 * 1000;
/** Every live game is held in memory, so there's a ceiling on how many can run at once. */
export const MAX_LIVE_ROOMS = 500;

/** Thrown when starting one more game would pass the ceiling. */
export class TooManyRoomsError extends Error {
  constructor() {
    super('Too many games are running');
  }
}

const startedAt = Date.now();
const startedSteady = performance.now();

/**
 * Wall-clock time that only ever moves forward at a steady rate. System clocks get
 * adjusted, sometimes by a second or more, which mustn't shift a deadline mid-round.
 */
export function steadyNow(): number {
  return Math.round(startedAt + performance.now() - startedSteady);
}

function snapshotKey(roomId: string): string {
  return `${SNAPSHOT_PREFIX}${roomId}.json`;
}

/** What a game plays when no deck is named. */
export const STARTER_SETUP: RoomSetup = {
  title: 'The Presentation Game',
  games: [
    {
      type: 'define',
      items: SAMPLE_WORDS,
    },
    { type: 'geo' },
    { type: 'caption' },
  ],
};

export interface ManagerOptions {
  storage: Storage;
  now?: () => number;
  snapshotDelayMs?: number;
  onSnapshotError?: (error: unknown) => void;
  maxRooms?: number;
}

interface Entry {
  room: Room;
  joinBucket: TokenBucket;
  timer: NodeJS.Timeout | null;
  writing: Promise<void> | null;
  dirty: boolean;
}

/** Holds the live rooms and keeps a copy of each in storage, so a restart loses little. */
export class RoomManager {
  private readonly entries = new Map<string, Entry>();
  private readonly storage: Storage;
  private readonly snapshotDelayMs: number;
  private readonly onSnapshotError: (error: unknown) => void;
  private readonly maxRooms: number;
  readonly now: () => number;

  constructor(options: ManagerOptions) {
    this.storage = options.storage;
    this.now = options.now ?? steadyNow;
    this.snapshotDelayMs = options.snapshotDelayMs ?? SNAPSHOT_DELAY_MS;
    this.onSnapshotError = options.onSnapshotError ?? (() => undefined);
    this.maxRooms = options.maxRooms ?? MAX_LIVE_ROOMS;
  }

  /** Runs before the server starts listening, so a returning phone always finds its room. */
  async restore(): Promise<number> {
    const cutoff = this.now() - ROOM_LIFETIME_MS;
    let restored = 0;
    for (const key of await this.storage.list(SNAPSHOT_PREFIX)) {
      const stored = await this.storage.get(key);
      if (!stored) continue;
      let room: Room | null = null;
      try {
        room = Room.fromSnapshot(JSON.parse(stored.body.toString('utf8')), this.now());
      } catch {
        room = null;
      }
      if (!room) {
        this.onSnapshotError(new Error(`Skipped an unreadable snapshot: ${key}`));
        continue;
      }
      if (room.updatedAt < cutoff) {
        await this.storage.delete(key).catch(this.onSnapshotError);
        continue;
      }
      this.entries.set(room.id, this.entryFor(room));
      restored += 1;
    }
    return restored;
  }

  async create(setup: RoomSetup): Promise<Room> {
    if (this.entries.size >= this.maxRooms) {
      // Games nobody has touched for a day make way first, then hosted games nobody ever joined.
      await this.sweep();
      if (this.entries.size >= this.maxRooms) await this.dropUnplayed();
      if (this.entries.size >= this.maxRooms) throw new TooManyRoomsError();
    }
    // 128 random bits, so a room link can't practically be guessed.
    const room = new Room(randomId(16), setup, this.now());
    this.entries.set(room.id, this.entryFor(room));
    await this.saveNow(room.id);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.entries.get(roomId)?.room;
  }

  list(): Room[] {
    return [...this.entries.values()].map((entry) => entry.room);
  }

  /** Limits how fast names can arrive across a whole room, however many connections send them. */
  allowJoinAttempt(roomId: string): boolean {
    return this.entries.get(roomId)?.joinBucket.take(this.now()) ?? false;
  }

  /** Call after any change worth keeping. Screen changes save at once, others within 2 seconds. */
  changed(roomId: string, options: { immediate?: boolean } = {}): void {
    const entry = this.entries.get(roomId);
    if (!entry) return;
    entry.dirty = true;
    if (options.immediate) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      void this.saveNow(roomId);
      return;
    }
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.saveNow(roomId);
    }, this.snapshotDelayMs);
    entry.timer.unref();
  }

  /** Writes one at a time, always ending with the newest state. */
  private async saveNow(roomId: string): Promise<void> {
    const entry = this.entries.get(roomId);
    if (!entry) return;
    entry.dirty = true;
    if (entry.writing) return entry.writing;
    entry.writing = this.drain(entry).finally(() => {
      entry.writing = null;
    });
    return entry.writing;
  }

  private async drain(entry: Entry): Promise<void> {
    while (entry.dirty) {
      entry.dirty = false;
      try {
        await this.storage.put(
          snapshotKey(entry.room.id),
          JSON.stringify(entry.room.toSnapshot()),
          'application/json',
        );
      } catch (error) {
        this.onSnapshotError(error);
        this.retryLater(entry);
        return;
      }
    }
  }

  private retryLater(entry: Entry): void {
    entry.dirty = true;
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.saveNow(entry.room.id);
    }, RETRY_DELAY_MS);
    entry.timer.unref();
  }

  /** Called when the pod is being replaced, so nothing recent is lost. */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        return entry.dirty || entry.writing ? this.saveNow(entry.room.id) : undefined;
      }),
    );
  }

  /** Forgets rooms nobody has touched for a day, including their stored copies. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - ROOM_LIFETIME_MS;
    for (const entry of [...this.entries.values()]) {
      if (entry.room.updatedAt >= cutoff) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(entry.room.id);
      await this.storage.delete(snapshotKey(entry.room.id)).catch(this.onSnapshotError);
      await this.dropped(entry.room);
    }
  }

  /**
   * Called for every game the server ends by itself, so it's torn down like one a presenter ended:
   * phones are told, and photos only it was keeping can go.
   */
  onDropped(handler: (room: Room) => Promise<void> | void): void {
    this.droppedHandler = handler;
  }

  private droppedHandler: (room: Room) => Promise<void> | void = () => undefined;

  private async dropped(room: Room): Promise<void> {
    try {
      await this.droppedHandler(room);
    } catch (error) {
      this.onSnapshotError(error);
    }
  }

  /**
   * Frees the oldest hosted game that nobody has joined and nobody has touched for an hour.
   * Anyone can make a space on a hosted server, so without this, games started and left empty
   * could fill every slot. The main space's games are never dropped.
   */
  private async dropUnplayed(): Promise<void> {
    const cutoff = this.now() - UNPLAYED_LIFETIME_MS;
    const oldest = this.list()
      .filter((room) => room.space !== MAIN_SPACE && room.playerCount === 0 && room.updatedAt < cutoff)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) return;
    const room = await this.delete(oldest.id).catch((error) => {
      this.onSnapshotError(error);
      return null;
    });
    if (room) await this.dropped(room);
  }

  /** Ends a game for good, including its stored copy. Returns the room, or null if there was none. */
  async delete(roomId: string): Promise<Room | null> {
    const entry = this.entries.get(roomId);
    if (!entry) return null;
    this.entries.delete(roomId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.dirty = false;
    // A save already on its way would otherwise land after the delete and bring the room back on restart.
    await entry.writing?.catch(() => undefined);
    await this.storage.delete(snapshotKey(roomId));
    return entry.room;
  }

  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private entryFor(room: Room): Entry {
    // A burst big enough for everyone scanning the QR code at once.
    return { room, joinBucket: new TokenBucket(80, 5, this.now()), timer: null, writing: null, dirty: false };
  }
}
