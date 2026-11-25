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
import { randomId } from './ids.js';
import type { RoomSetup } from './session/room.js';
import type { Storage } from './storage/index.js';

const FOLDER = 'decks/';

function keyFor(id: string): string {
  return `${FOLDER}${id}.json`;
}

type SaveOutcome =
  | { kind: 'saved'; deck: StoredDeck }
  | { kind: 'missing' }
  /** Saved from somewhere else since this copy was opened. */
  | { kind: 'conflict'; revision: number };

/** Decks live in storage, because containers lose their files when they're replaced. */
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

  private write(deck: StoredDeck): Promise<void> {
    return this.storage.put(keyFor(deck.id), JSON.stringify(deck), 'application/json');
  }

  async get(id: string): Promise<StoredDeck | null> {
    const stored = await this.storage.get(keyFor(id));
    if (!stored) return null;
    try {
      return storedDeckSchema.parse(JSON.parse(stored.body.toString('utf8')));
    } catch {
      return null;
    }
  }

  async all(): Promise<StoredDeck[]> {
    const decks = await Promise.all(
      (await this.storage.list(FOLDER)).map((key) => this.get(key.slice(FOLDER.length, -'.json'.length))),
    );
    return decks.filter((deck): deck is StoredDeck => deck !== null);
  }

  async summaries(): Promise<DeckSummary[]> {
    return (await this.all())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((deck) => ({
        id: deck.id,
        title: deck.content.title,
        updatedAt: deck.updatedAt,
        games: deck.content.games.map((game) => ({ type: game.type, count: game.items.length })),
      }));
  }

  create(content: DeckContent): Promise<StoredDeck> {
    return this.inTurn(async () => {
      const deck: StoredDeck = { id: randomId(12), revision: 1, updatedAt: this.now(), content };
      await this.write(deck);
      return deck;
    });
  }

  save(id: string, revision: number, content: DeckContent): Promise<SaveOutcome> {
    return this.inTurn(async () => {
      const current = await this.get(id);
      if (!current) return { kind: 'missing' };
      if (current.revision !== revision) return { kind: 'conflict', revision: current.revision };
      const deck: StoredDeck = { ...current, revision: revision + 1, updatedAt: this.now(), content };
      await this.write(deck);
      return { kind: 'saved', deck };
    });
  }

  delete(id: string): Promise<void> {
    return this.inTurn(() => this.storage.delete(keyFor(id)));
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
            settings: writeVoteSettings(s, { findReal: s.findReal, perFooled: s.perFooled, fooledMax: s.fooledMax }),
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
            settings: writeVoteSettings(s, { perVote: s.perVote, voteMax: s.voteMax, topBonus: s.topBonus }),
            items: game.items.map((item) => ({ image: item.image, extras: item.extras ?? [] })),
          };
        }
        if (game.type === 'choice') {
          return {
            type: 'choice',
            settings: { answerMs: ms(game.settings.answerSeconds), points: game.settings.points },
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
            guessMs: ms(game.settings.guessSeconds),
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

function ms(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Define it and Caption this share their timers. Points left out of the deck keep their defaults. */
function writeVoteSettings(
  s: { writeSeconds?: number; voteSeconds?: number; showSeconds?: number },
  points: Record<string, number | undefined>,
) {
  return { writeMs: ms(s.writeSeconds), voteMs: ms(s.voteSeconds), showMs: ms(s.showSeconds), points: definedOnly(points) };
}

function definedOnly<T extends Record<string, number | undefined>>(values: T): Partial<Record<keyof T, number>> {
  const result: Partial<Record<keyof T, number>> = {};
  for (const key of Object.keys(values) as (keyof T)[]) {
    const value = values[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
