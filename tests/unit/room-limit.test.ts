import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomManager, TooManyRoomsError } from '../../server/session/manager.js';
import type { RoomSetup } from '../../server/session/room.js';
import { DiskStorage } from '../../server/storage/disk.js';

const HOUR = 60 * 60 * 1000;
const SETUP: RoomSetup = { title: 'Test', games: [{ type: 'define', items: [{ word: 'a', definition: 'b' }] }] };

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
    await rooms.create(SETUP);
    await expect(rooms.create(SETUP)).rejects.toBeInstanceOf(TooManyRoomsError);
  });

  it('tears down a day-old game like one the presenter ended', async () => {
    const old = await rooms.create(SETUP);
    const dropped: string[] = [];
    rooms.onDropped((room) => {
      dropped.push(room.id);
    });
    now += 25 * HOUR;
    await rooms.sweep();
    expect(dropped).toEqual([old.id]);
  });
});
