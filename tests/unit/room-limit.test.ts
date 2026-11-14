import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomManager, TooManyRoomsError } from '../../server/session/manager.js';
import type { RoomSetup } from '../../server/session/room.js';
import { DiskStorage } from '../../server/storage/disk.js';

const HOUR = 60 * 60 * 1000;
const SETUP: RoomSetup = { title: 'Test', games: [{ type: 'define', items: [{ word: 'a', definition: 'b' }] }] };
const hosted = (space = 'abcdefghijklmnop'): RoomSetup => ({ ...SETUP, space });

describe('the ceiling on live games', () => {
  let root: string;
  let now: number;
  let rooms: RoomManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'trip-party-rooms-'));
    now = 1_000_000_000;
    rooms = new RoomManager({ storage: new DiskStorage(root), now: () => now, maxRooms: 2, snapshotDelayMs: 1 });
  });

  afterEach(async () => {
    rooms.close();
    await rooms.flush();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses one more game once full', async () => {
    await rooms.create(SETUP);
    await rooms.create(hosted());
    await expect(rooms.create(SETUP)).rejects.toBeInstanceOf(TooManyRoomsError);
  });

  it('makes way by dropping the oldest hosted game nobody joined in an hour', async () => {
    const left = await rooms.create(hosted());
    now += 10;
    const played = await rooms.create(hosted());
    played.join('a'.repeat(43), 'Alex', now);
    now += 2 * HOUR;
    const dropped: string[] = [];
    rooms.onDropped((room) => {
      dropped.push(room.id);
    });
    const fresh = await rooms.create(hosted());
    expect(dropped).toEqual([left.id]);
    expect(rooms.get(left.id)).toBeUndefined();
    expect(rooms.get(played.id)).toBe(played);
    expect(rooms.get(fresh.id)).toBe(fresh);
  });

  it('tears down a day-old game the same way', async () => {
    const old = await rooms.create(SETUP);
    const dropped: string[] = [];
    rooms.onDropped((room) => {
      dropped.push(room.id);
    });
    now += 25 * HOUR;
    await rooms.sweep();
    expect(dropped).toEqual([old.id]);
  });

  it("keeps a hosted game that's been empty for less than an hour, and the main space's games", async () => {
    await rooms.create(SETUP);
    now += 2 * HOUR;
    await rooms.create(hosted());
    now += HOUR / 2;
    await expect(rooms.create(hosted())).rejects.toBeInstanceOf(TooManyRoomsError);
  });

  it('keeps a tenth of the slots for the main space, so hosted spaces can never take every one', async () => {
    const big = new RoomManager({ storage: new DiskStorage(root), now: () => now, maxRooms: 10, snapshotDelayMs: 1 });
    try {
      for (let i = 0; i < 9; i++) await big.create(hosted());
      await expect(big.create(hosted())).rejects.toBeInstanceOf(TooManyRoomsError);
      await expect(big.create(SETUP)).resolves.toBeDefined();
    } finally {
      big.close();
      await big.flush();
    }
  });

  it('makes way by dropping the hosted game that has gone longest with no TV, once that is half an hour', async () => {
    const watched = await rooms.create(hosted());
    watched.join('a'.repeat(43), 'Alex', now);
    rooms.watching(watched.id, 1);
    const unwatched = await rooms.create(hosted());
    // A guest keeps it looking busy, but nobody has its TV open.
    unwatched.join('b'.repeat(43), 'Sam', now);
    now += 20 * 60 * 1000;
    await expect(rooms.create(hosted())).rejects.toBeInstanceOf(TooManyRoomsError);
    now += 15 * 60 * 1000;
    unwatched.join('c'.repeat(43), 'Kai', now);
    const fresh = await rooms.create(hosted());
    expect(rooms.get(unwatched.id)).toBeUndefined();
    expect(rooms.get(watched.id)).toBe(watched);
    expect(rooms.get(fresh.id)).toBe(fresh);
  });
});
