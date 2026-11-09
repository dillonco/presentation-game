import { randomInt } from 'node:crypto';
import { accentColours } from '../shared/color.js';
import { cleanName } from '../shared/names.js';
import {
  clipToPlay,
  storedDeckSchema,
  type DeckContent,
  type DeckSummary,
  type StoredDeck,
} from '../shared/deck.js';
import { randomId, type RoomSetup } from './session/room.js';
import { MAIN_SPACE, spacePrefix } from './spaces.js';
import type { Storage } from './storage/index.js';

/** The main space keeps decks where they always were, so existing servers carry on as before. */
function folderFor(space: string): string {
  return space === MAIN_SPACE ? 'decks/' : `${spacePrefix(space)}decks/`;
}

function keyFor(space: string, id: string): string {
  return `${folderFor(space)}${id}.json`;
}

export type SaveOutcome =
  | { kind: 'saved'; deck: StoredDeck }
  | { kind: 'missing' }
  /** Saved from somewhere else since this copy was opened. */
  | { kind: 'conflict'; revision: number };

/**
 * Decks live in storage, because containers lose their files when they're replaced. Every call
 * names the space, so one presenter can never reach another's decks.
 */
export class DeckStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: Storage,
    private readonly now: () => number,
  ) {}

  /** One write at a time, so two saves can't both pass the revision check. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private write(space: string, deck: StoredDeck): Promise<void> {
    return this.storage.put(keyFor(space, deck.id), JSON.stringify(deck), 'application/json');
  }

  async get(space: string, id: string): Promise<StoredDeck | null> {
    const stored = await this.storage.get(keyFor(space, id));
    if (!stored) return null;
    try {
      return storedDeckSchema.parse(JSON.parse(stored.body.toString('utf8')));
    } catch {
      return null;
    }
  }

  async count(space: string): Promise<number> {
    return (await this.storage.list(folderFor(space))).length;
  }

  async all(space: string): Promise<StoredDeck[]> {
    const folder = folderFor(space);
    const decks = await Promise.all(
      (await this.storage.list(folder)).map((key) => this.get(space, key.slice(folder.length, -'.json'.length))),
    );
    return decks.filter((deck): deck is StoredDeck => deck !== null);
  }

  async summaries(space: string): Promise<DeckSummary[]> {
    return (await this.all(space))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((deck) => ({
        id: deck.id,
        title: deck.content.title,
        updatedAt: deck.updatedAt,
        games: deck.content.games.map((game) => ({ type: game.type, count: game.items.length })),
      }));
  }

  /** Null when the space already holds `limit` decks. Counted in turn, so decks made at once can't pass it together. */
  create(space: string, content: DeckContent, limit = Infinity): Promise<StoredDeck | null> {
    return this.inTurn(async () => {
      if (limit !== Infinity && (await this.count(space)) >= limit) return null;
      const deck: StoredDeck = { id: randomId(12), revision: 1, updatedAt: this.now(), content };
      await this.write(space, deck);
      return deck;
    });
  }

  save(space: string, id: string, revision: number, content: DeckContent): Promise<SaveOutcome> {
    return this.inTurn(async () => {
      const current = await this.get(space, id);
      if (!current) return { kind: 'missing' };
      if (current.revision !== revision) return { kind: 'conflict', revision: current.revision };
      const deck: StoredDeck = { ...current, revision: revision + 1, updatedAt: this.now(), content };
      await this.write(space, deck);
      return { kind: 'saved', deck };
    });
  }

  delete(space: string, id: string): Promise<void> {
    return this.inTurn(() => this.storage.delete(keyFor(space, id)));
  }
}

/** What a game actually plays. Empty games are simply left out of the night. */
export function deckToSetup(content: DeckContent): RoomSetup {
  return {
    title: cleanName(content.title),
    accent: content.theme.accent ? accentColours(content.theme.accent) : undefined,
    country: content.region.country,
    blocklist: content.moderation.blocklist,
    similarity: content.moderation.similarity,
    showLeftPage: content.moderation.showLeftPage,
    tips: (content.tips ?? []).map((tip) => ({
      heading: cleanName(tip.heading),
      text: cleanName(tip.text),
      places: tip.places.map((place) => ({ ...place, name: cleanName(place.name) })),
      image: tip.image,
    })),
    games: content.games
      .filter((game) => game.items.length > 0)
      .map((game): RoomSetup['games'][number] => {
        if (game.type === 'define') {
          const s = game.settings;
          return {
            type: 'define',
            settings: {
              writeMs: s.writeSeconds === undefined ? undefined : s.writeSeconds * 1000,
              voteMs: s.voteSeconds === undefined ? undefined : s.voteSeconds * 1000,
              showMs: s.showSeconds === undefined ? undefined : s.showSeconds * 1000,
              points: definedOnly({ findReal: s.findReal, perFooled: s.perFooled, fooledMax: s.fooledMax }),
            },
            items: game.items.map((item) => {
              const clip = clipToPlay(item.clip);
              return { word: cleanName(item.word), definition: cleanName(item.definition), ...(clip ? { clip } : {}) };
            }),
          };
        }
        if (game.type === 'caption') {
          const s = game.settings;
          return {
            type: 'caption',
            settings: {
              writeMs: s.writeSeconds === undefined ? undefined : s.writeSeconds * 1000,
              voteMs: s.voteSeconds === undefined ? undefined : s.voteSeconds * 1000,
              showMs: s.showSeconds === undefined ? undefined : s.showSeconds * 1000,
              points: definedOnly({ perVote: s.perVote, voteMax: s.voteMax, topBonus: s.topBonus }),
            },
            items: game.items.map((item) => ({ image: item.image, extras: item.extras ?? [] })),
          };
        }
        if (game.type === 'choice') {
          const s = game.settings;
          return {
            type: 'choice',
            settings: {
              answerMs: s.answerSeconds === undefined ? undefined : s.answerSeconds * 1000,
              points: s.points,
            },
            items: game.items.map((item) => {
              const order = shuffled(item.options.map((_, index) => index));
              return {
                image: item.image,
                question: cleanName(item.question),
                options: order.map((index) => cleanName(item.options[index]!)),
                answer: order.indexOf(item.answer),
                extras: item.extras ?? [],
              };
            }),
          };
        }
        return {
          type: 'geo',
          settings: {
            guessMs: game.settings.guessSeconds === undefined ? undefined : game.settings.guessSeconds * 1000,
            maxPoints: game.settings.maxPoints,
          },
          items: game.items.map((item) => ({
            image: item.image,
            label: cleanName(item.label),
            // deckProblems has already refused any photo without a location.
            lat: item.lat ?? 0,
            lng: item.lng ?? 0,
            extras: item.extras ?? [],
          })),
        };
      }),
  };
}

/**
 * Pick one's answers are shuffled for each game, so a deck that always puts the right one first
 * doesn't teach the room where to look. The shuffled order is kept in the game's setup, so a
 * restart doesn't move anything.
 */
function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function definedOnly<T extends Record<string, number | undefined>>(values: T): Partial<Record<keyof T, number>> {
  const result: Partial<Record<keyof T, number>> = {};
  for (const key of Object.keys(values) as (keyof T)[]) {
    const value = values[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
