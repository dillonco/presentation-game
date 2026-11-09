import type { DeckStore } from './decks.js';
import type { MediaStore } from './media.js';
import type { RoomManager } from './session/manager.js';
import { spacePrefix, type SpaceStore } from './spaces.js';
import type { Storage } from './storage/index.js';

/** A space nobody has used for this long goes, with its decks and photos. As long as a session lasts. */
export const SPACE_IDLE_MS = 180 * 24 * 60 * 60 * 1000;
/**
 * A space that never got a deck or a photo goes after a day, so spaces made and left empty can't
 * pile up towards the ceiling. Its presenter loses nothing but the join code.
 */
export const EMPTY_SPACE_IDLE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SPACES = 5000;

export interface SpaceSweepOptions {
  storage: Storage;
  spaces: SpaceStore;
  decks: DeckStore;
  media: MediaStore;
  rooms: RoomManager;
  now: () => number;
}

/** Deletes everything a space keeps: its photos and videos, its decks, its join code and itself. */
export async function deleteSpace({ storage, spaces, media }: SpaceSweepOptions, id: string): Promise<void> {
  const prefix = spacePrefix(id);
  const mediaFolder = `${prefix}media/`;
  for (const key of await storage.list(mediaFolder)) {
    await media.deleteOwned(id, key.slice(mediaFolder.length));
  }
  for (const key of await storage.list(prefix)) {
    if (key !== `${prefix}space.json`) await storage.delete(key);
  }
  await spaces.delete(id);
}

/** Clears out spaces nobody uses any more. Never one with a game still running. Returns how many went. */
export async function sweepSpaces(options: SpaceSweepOptions): Promise<number> {
  const { spaces, decks, media, rooms, now } = options;
  const playing = new Set(rooms.list().map((room) => room.space));
  let removed = 0;
  for (const id of spaces.ids()) {
    if (playing.has(id)) continue;
    const idle = now() - (spaces.lastUsed(id) ?? now());
    if (idle < EMPTY_SPACE_IDLE_MS) continue;
    const empty = idle < SPACE_IDLE_MS && (await decks.count(id)) === 0 && (await media.countOwned(id)) === 0;
    if (idle >= SPACE_IDLE_MS || empty) {
      await deleteSpace(options, id);
      removed += 1;
    }
  }
  return removed;
}
