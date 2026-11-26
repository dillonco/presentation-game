import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../../shared/deck.js';
import { DeckStore } from '../../server/decks.js';
import { clearHostedLeftovers } from '../../server/hosted-leftovers.js';
import { MediaStore, newImageId } from '../../server/media.js';
import { DiskStorage } from '../../server/storage/disk.js';

describe('clearing what hosted spaces left behind', () => {
  let root: string;
  let storage: DiskStorage;
  let decks: DeckStore;
  let media: MediaStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'presentation-game-leftovers-'));
    storage = new DiskStorage(root);
    decks = new DeckStore(storage, () => Date.now());
    media = new MediaStore(storage, join(root, 'cache'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const photo = async (owner?: string) => {
    const id = newImageId();
    await media.save(id, 'full', Buffer.from('full'));
    await media.save(id, 'small', Buffer.from('small'));
    if (owner) await storage.put(`owners/${id}`, owner, 'text/plain');
    return id;
  };
  const game = (id: string, setup: object) => storage.put(`rooms/${id}.json`, JSON.stringify({ id, setup }), 'application/json');
  const caption = (images: string[]) => ({ type: 'caption', items: images.map((image) => ({ image })) });

  it("deletes other spaces' games, uploads and records, and keeps the presenter's", async () => {
    const strangers = await photo('abc');
    const mine = await photo();
    const sharedWithMyDeck = await photo('abc');
    const inMyGame = await photo('abc');
    await decks.create({ ...emptyDeck(), games: [{ type: 'caption', settings: {}, items: [{ image: sharedWithMyDeck }] }] });
    await game('theirs', { title: 'Theirs', space: 'abc', games: [caption([strangers])] });
    await game('mine', { title: 'Mine', games: [caption([inMyGame])] });
    await storage.put('spaces/abc/space.json', '{}', 'application/json');
    await storage.put('spaces/abc/decks/d.json', '{}', 'application/json');
    await storage.put('codes/ABCDEF.json', '{}', 'application/json');

    expect(await clearHostedLeftovers({ storage, decks, media })).toEqual({ games: 1, uploads: 1 });

    expect(await media.exists(strangers)).toBe(false);
    for (const kept of [mine, sharedWithMyDeck, inMyGame]) expect(await media.exists(kept)).toBe(true);
    expect(await storage.list('rooms/')).toEqual(['rooms/mine.json']);
    for (const prefix of ['owners/', 'spaces/', 'codes/']) expect(await storage.list(prefix)).toEqual([]);
  });

  it('does nothing on a server that never hosted', async () => {
    const mine = await photo();
    await game('mine', { title: 'Mine', games: [caption([mine])] });
    expect(await clearHostedLeftovers({ storage, decks, media })).toEqual({ games: 0, uploads: 0 });
    expect(await media.exists(mine)).toBe(true);
    expect(await storage.list('rooms/')).toEqual(['rooms/mine.json']);
  });
});
