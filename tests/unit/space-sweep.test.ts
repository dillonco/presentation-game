import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../../shared/deck.js';
import { DeckStore } from '../../server/decks.js';
import { MediaStore, newImageId } from '../../server/media.js';
import { RoomManager } from '../../server/session/manager.js';
import { EMPTY_SPACE_IDLE_MS, SPACE_IDLE_MS, sweepSpaces, type SpaceSweepOptions } from '../../server/space-sweep.js';
import { SpaceStore } from '../../server/spaces.js';
import { DiskStorage } from '../../server/storage/disk.js';

const PHOTO = readFileSync('tests/fixtures/plain.jpg');
const DAY = 24 * 60 * 60 * 1000;

describe('clearing out spaces nobody uses', () => {
  let root: string;
  let now: number;
  let options: SpaceSweepOptions;
  let storage: DiskStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'trip-party-spaces-'));
    now = 1_000_000_000_000;
    storage = new DiskStorage(join(root, 'storage'));
    const clock = () => now;
    options = {
      storage,
      spaces: new SpaceStore(storage, 'a-secret-long-enough', clock),
      decks: new DeckStore(storage, clock),
      media: new MediaStore(storage, join(root, 'cache')),
      rooms: new RoomManager({ storage, now: clock }),
      now: clock,
    };
  });

  afterEach(async () => {
    options.rooms.close();
    await rm(root, { recursive: true, force: true });
  });

  async function spaceWithPhoto() {
    const space = await options.spaces.create();
    const photo = newImageId();
    await options.media.save(photo, 'full', PHOTO);
    await options.media.claim(space.id, photo);
    await options.decks.create(space.id, emptyDeck());
    return { space, photo };
  }

  it('deletes an empty space after a day, and keeps it until then', async () => {
    const space = await options.spaces.create();
    now += EMPTY_SPACE_IDLE_MS - 1000;
    expect(await sweepSpaces(options)).toBe(0);
    now += 2000;
    expect(await sweepSpaces(options)).toBe(1);
    expect(await options.spaces.get(space.id)).toBeNull();
    expect(await options.spaces.spaceForCode(space.code)).toBeNull();
  });

  it('keeps a space with decks until it has been idle for the full time, then deletes everything it had', async () => {
    const { space, photo } = await spaceWithPhoto();
    now += SPACE_IDLE_MS - DAY;
    expect(await sweepSpaces(options)).toBe(0);
    now += 2 * DAY;
    expect(await sweepSpaces(options)).toBe(1);
    expect(await options.media.read(photo, 'full')).toBeNull();
    expect(await storage.list('spaces/')).toEqual([]);
    expect(await storage.list('owners/')).toEqual([]);
    expect(await storage.list('codes/')).toEqual([]);
    expect(await options.spaces.get(space.id)).toBeNull();
  });

  it('counts using a space as activity', async () => {
    const { space } = await spaceWithPhoto();
    now += SPACE_IDLE_MS - DAY;
    await options.spaces.touch(space.id);
    now += 2 * DAY;
    expect(await sweepSpaces(options)).toBe(0);
  });

  it('never deletes a space with a game running', async () => {
    const space = await options.spaces.create();
    await options.rooms.create({ title: 'Live', space: space.id, games: [] });
    now += SPACE_IDLE_MS + DAY;
    expect(await sweepSpaces(options)).toBe(0);
  });
});

describe('changes to one space', () => {
  it("never let a slow save put back a generation that's been reset", async () => {
    const root = await mkdtemp(join(tmpdir(), 'trip-party-spaces-'));
    try {
      let now = 1_000_000_000_000;
      const disk = new DiskStorage(root);
      // Saves of space.json take a while, so a touch and a reset overlap.
      const slow = Object.create(disk) as DiskStorage;
      slow.put = async (key, body, type) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return disk.put(key, body, type);
      };
      const spaces = new SpaceStore(slow, 'a-secret-long-enough', () => now);
      const space = await spaces.create();
      now += 2 * DAY;
      await Promise.all([spaces.touch(space.id), spaces.resetPresenterKey(space.id)]);
      expect(spaces.generation(space.id)).toBe(1);
      const reloaded = new SpaceStore(disk, 'a-secret-long-enough', () => now);
      await reloaded.load();
      expect(reloaded.generation(space.id)).toBe(1);
      expect(reloaded.lastUsed(space.id)).toBe(now);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
