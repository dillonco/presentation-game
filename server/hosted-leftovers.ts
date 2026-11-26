import { imagesInDeck, MEDIA_ID_PATTERN } from '../shared/deck.js';
import type { DeckStore } from './decks.js';
import type { MediaStore } from './media.js';
import type { Storage } from './storage/index.js';

/**
 * Servers that once ran with HOSTED=true kept other people's spaces in storage: each space under
 * `spaces/<id>/`, its join code under `codes/`, a record under `owners/<media id>` for every photo
 * or video it uploaded, and its games in `rooms/` with a `space` in their setup. The presenter's
 * own uploads never got an `owners/` record. This clears all of that, and finds nothing to do once
 * it has run. Returns how many games and uploads went.
 */
export async function clearHostedLeftovers({
  storage,
  decks,
  media,
}: {
  storage: Storage;
  decks: DeckStore;
  media: MediaStore;
}): Promise<{ games: number; uploads: number }> {
  const owned = await storage.list('owners/');
  const spaceKeys = [...(await storage.list('spaces/')), ...(await storage.list('codes/'))];
  if (owned.length === 0 && spaceKeys.length === 0) return { games: 0, uploads: 0 };

  // Anything the presenter still uses stays, even if a hosted space uploaded it first.
  const inUse = new Set<string>();
  for (const deck of await decks.all()) imagesInDeck(deck.content).forEach((image) => inUse.add(image));

  let games = 0;
  for (const key of await storage.list('rooms/')) {
    const setup = readSetup((await storage.get(key))?.body.toString('utf8'));
    if (setup?.space !== undefined && setup.space !== 'main') {
      await storage.delete(key);
      games += 1;
    } else {
      setupImages(setup).forEach((image) => inUse.add(image));
    }
  }

  let uploads = 0;
  for (const key of owned) {
    const id = key.slice('owners/'.length);
    if (MEDIA_ID_PATTERN.test(id) && !inUse.has(id)) {
      await media.delete(id);
      uploads += 1;
    }
    await storage.delete(key);
  }
  for (const key of spaceKeys) await storage.delete(key);
  return { games, uploads };
}

interface LooseSetup {
  space?: string;
  games?: { items?: { image?: string; extras?: string[] }[] }[];
  tips?: { image?: string }[];
}

function readSetup(text: string | undefined): LooseSetup | null {
  try {
    const snapshot = text ? (JSON.parse(text) as { setup?: LooseSetup }) : null;
    return snapshot?.setup ?? null;
  } catch {
    return null;
  }
}

function setupImages(setup: LooseSetup | null): string[] {
  if (!setup) return [];
  return [
    ...(setup.games ?? []).flatMap((game) => (game.items ?? []).flatMap((item) => [item.image ?? '', ...(item.extras ?? [])])),
    ...(setup.tips ?? []).map((tip) => tip.image ?? ''),
  ].filter(Boolean);
}
