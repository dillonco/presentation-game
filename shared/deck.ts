import { z } from 'zod';
import { accentIsReadable, HEX_COLOUR } from './color.js';
import { MAX_ANSWER_LENGTH } from './constants.js';
import { findCountry, insideCountry } from './countries.js';
import { cleanName, answerProblem, nameKey } from './names.js';
import { MAX_CLIP_SECONDS, MAX_CLIP_TIME, parseYouTubeLink, type WordClip } from './youtube.js';

/**
 * A deck is everything specific to one night: words, photos, timers and rules.
 * A new trip or topic needs a new deck, not new code.
 *
 * Drafts are allowed to be unfinished, so the builder can save as you type.
 * `deckProblems` decides whether one is ready to play.
 */

export const DECK_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
export const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** A video's id is a photo-style id with a `v` in front, so everything that passes ids around works unchanged. */
export const VIDEO_ID_PATTERN = /^v[A-Za-z0-9_-]{22}$/;
/** Either kind. Each item in a deck can be a photo or a video. */
export const MEDIA_ID_PATTERN = /^v?[A-Za-z0-9_-]{22}$/;

export function isVideoId(id: string): boolean {
  return VIDEO_ID_PATTERN.test(id);
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Videos are sent as they are, so they get far more room than a resized photo. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_MB = MAX_VIDEO_BYTES / 1024 / 1024;
export const MAX_DECK_TITLE = 60;
export const MAX_WORD = 40;
export const MAX_PLACE_LABEL = 60;
/** Pick one: the question beside the photo, and each of its four answers. */
export const MAX_QUESTION = 100;
export const MAX_CHOICE = 60;
export const CHOICE_COUNT = 4;
export const MAX_ITEMS_PER_GAME = 30;
/** More photos from the same moment, shown on the TV once a photo's round is over. */
export const MAX_EXTRA_PHOTOS = 5;
export const MAX_GAMES = 12;
export const MAX_BLOCKED_WORDS = 200;
export const MAX_BLOCKED_WORD = 40;
/** Trip tips: the page after the podium, with what you'd tell a friend going next. */
export const MAX_TIPS = 10;
export const MAX_TIP_HEADING = 40;
export const MAX_TIP_TEXT = 200;
export const MAX_TIP_PLACES = 3;
export const MAX_PLACE_NAME = 60;
export const MAX_LINK = 500;

export const MIN_SECONDS = 10;
export const MAX_SECONDS = 300;
export const MIN_SHOW_SECONDS = 2;
export const MAX_SHOW_SECONDS = 30;
export const MAX_POINTS = 10_000;

const seconds = z.number().int().min(MIN_SECONDS).max(MAX_SECONDS).optional();
const points = z.number().int().min(0).max(MAX_POINTS).optional();
const imageId = z.string().regex(MEDIA_ID_PATTERN);
/** Left out by decks made before extra photos existed, which still load as they were. */
const extras = z.array(imageId).max(MAX_EXTRA_PHOTOS).optional();

/** Left out, each answer gets time according to its length. */
const showSeconds = z.number().int().min(MIN_SHOW_SECONDS).max(MAX_SHOW_SECONDS).optional();

const clipTime = z.number().min(0).max(MAX_CLIP_TIME).nullable();

/**
 * Someone saying the word, from a YouTube video. Kept as typed so a half-pasted link survives,
 * and checked by `deckProblems`. Left out by decks made before clips existed.
 */
const wordClip = z.strictObject({ url: z.string().max(MAX_LINK), start: clipTime, end: clipTime });

const defineGame = z.strictObject({
  type: z.literal('define'),
  settings: z.strictObject({
    writeSeconds: seconds,
    voteSeconds: seconds,
    showSeconds,
    findReal: points,
    perFooled: points,
    fooledMax: points,
  }),
  items: z
    .array(
      z.strictObject({
        word: z.string().max(MAX_WORD * 2),
        definition: z.string().max(MAX_ANSWER_LENGTH * 2),
        clip: wordClip.optional(),
      }),
    )
    .max(MAX_ITEMS_PER_GAME),
});

const geoGame = z.strictObject({
  type: z.literal('geo'),
  settings: z.strictObject({ guessSeconds: seconds, maxPoints: points }),
  items: z
    .array(
      z.strictObject({
        image: imageId,
        label: z.string().max(MAX_PLACE_LABEL * 2),
        lat: z.number().min(-90).max(90).nullable(),
        lng: z.number().min(-180).max(180).nullable(),
        extras,
      }),
    )
    .max(MAX_ITEMS_PER_GAME),
});

const captionGame = z.strictObject({
  type: z.literal('caption'),
  settings: z.strictObject({
    writeSeconds: seconds,
    voteSeconds: seconds,
    showSeconds,
    perVote: points,
    voteMax: points,
    topBonus: points,
  }),
  items: z.array(z.strictObject({ image: imageId, extras })).max(MAX_ITEMS_PER_GAME),
});

const choiceGame = z.strictObject({
  type: z.literal('choice'),
  settings: z.strictObject({ answerSeconds: seconds, points }),
  items: z
    .array(
      z.strictObject({
        image: imageId,
        /** Left empty, the TV just asks which answer is right. */
        question: z.string().max(MAX_QUESTION * 2),
        options: z.array(z.string().max(MAX_CHOICE * 2)).length(CHOICE_COUNT),
        /** Which option is right. Guests see the four in a shuffled order. */
        answer: z.number().int().min(0).max(CHOICE_COUNT - 1),
        extras,
      }),
    )
    .max(MAX_ITEMS_PER_GAME),
});

/** A place found from a Google Maps link. The link is kept, so guests open the same place. */
const tipPlace = z.strictObject({
  name: z.string().max(MAX_PLACE_NAME * 2),
  url: z.string().max(MAX_LINK),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const tip = z.strictObject({
  heading: z.string().max(MAX_TIP_HEADING * 2),
  text: z.string().max(MAX_TIP_TEXT * 2),
  places: z.array(tipPlace).max(MAX_TIP_PLACES),
  image: imageId.nullable(),
});

export const deckContentSchema = z.strictObject({
  title: z.string().max(MAX_DECK_TITLE * 2),
  theme: z.strictObject({ accent: z.string().regex(HEX_COLOUR).nullable() }),
  region: z.strictObject({ country: z.string().max(80) }),
  moderation: z.strictObject({
    blocklist: z.array(z.string().max(MAX_BLOCKED_WORD)).max(MAX_BLOCKED_WORDS),
    similarity: z.enum(['loose', 'normal', 'strict']),
    showLeftPage: z.boolean(),
  }),
  games: z.array(z.discriminatedUnion('type', [defineGame, geoGame, captionGame, choiceGame])).max(MAX_GAMES),
  /** Left out by decks made before trip tips existed. Empty, the night ends on the podium. */
  tips: z.array(tip).max(MAX_TIPS).optional(),
});

export type DeckContent = z.infer<typeof deckContentSchema>;
export type DeckGame = DeckContent['games'][number];
export type DefineGame = z.infer<typeof defineGame>;
export type DeckClip = z.infer<typeof wordClip>;
export type GeoGame = z.infer<typeof geoGame>;
export type CaptionGame = z.infer<typeof captionGame>;
export type ChoiceGame = z.infer<typeof choiceGame>;
export type DeckTip = z.infer<typeof tip>;
export type TipPlace = z.infer<typeof tipPlace>;

export function emptyTip(): DeckTip {
  return { heading: '', text: '', places: [], image: null };
}

/** Only links that open a map, so a guest's tap can't be sent somewhere unexpected. */
export function isMapLink(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'maps.app.goo.gl' ||
      host === 'goo.gl' ||
      host === 'maps.google.com' ||
      ((host === 'www.google.com' || host === 'google.com') && url.pathname.startsWith('/maps'))
    );
  } catch {
    return false;
  }
}

export const storedDeckSchema = z.strictObject({
  id: z.string().regex(DECK_ID_PATTERN),
  /** Goes up with each save, so two open tabs can't silently overwrite each other. */
  revision: z.number().int().min(1),
  updatedAt: z.number(),
  content: deckContentSchema,
});

export type StoredDeck = z.infer<typeof storedDeckSchema>;

export const saveDeckSchema = z.strictObject({
  revision: z.number().int().min(1),
  content: deckContentSchema,
});

export interface DeckSummary {
  id: string;
  title: string;
  updatedAt: number;
  games: { type: DeckGame['type']; count: number }[];
}

export const GAME_LABELS: Record<DeckGame['type'], { name: string; item: string }> = {
  define: { name: 'Define it', item: 'word' },
  geo: { name: 'Where was this?', item: 'photo' },
  caption: { name: 'Caption this', item: 'photo' },
  choice: { name: 'Pick one', item: 'photo' },
};

export function emptyGame(type: DeckGame['type']): DeckGame {
  if (type === 'define') return { type, settings: {}, items: [] };
  if (type === 'geo') return { type, settings: {}, items: [] };
  if (type === 'choice') return { type, settings: {}, items: [] };
  return { type, settings: {}, items: [] };
}

/** A new Pick one photo, waiting for its question and answers. */
export function emptyChoice(image: string): ChoiceGame['items'][number] {
  return { image, question: '', options: Array.from({ length: CHOICE_COUNT }, () => ''), answer: 0 };
}

/** A, B, C, D, the way the TV, the phones and the builder label the answers. */
export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function emptyDeck(): DeckContent {
  return {
    title: 'New deck',
    theme: { accent: null },
    region: { country: 'Japan' },
    moderation: { blocklist: [], similarity: 'normal', showLeftPage: true },
    games: [emptyGame('define'), emptyGame('geo'), emptyGame('caption'), emptyGame('choice')],
  };
}

/** Real words, so a new presenter can try a round before writing their own. */
export const SAMPLE_WORDS = [
  { word: 'komorebi', definition: 'Sunlight filtering through the leaves of trees' },
  { word: 'tsundoku', definition: 'Buying books and letting them pile up unread' },
  { word: 'kuidaore', definition: 'Eating and drinking yourself into ruin' },
];

/** The words-only part of the sample. The server adds its photos, in `server/sample.ts`. */
export function sampleDeck(): DeckContent {
  return {
    ...emptyDeck(),
    title: 'Sample deck',
    games: [{ type: 'define', settings: {}, items: SAMPLE_WORDS }],
  };
}

export function imagesInDeck(content: DeckContent): string[] {
  const images: string[] = [];
  for (const game of content.games) {
    if (game.type === 'define') continue;
    for (const item of game.items) images.push(item.image, ...(item.extras ?? []));
  }
  for (const tip of content.tips ?? []) if (tip.image) images.push(tip.image);
  return images;
}

/** A clip with nothing filled in yet is the same as no clip, so it never blocks a deck. */
export function clipIsEmpty(clip: DeckClip | undefined): boolean {
  return !clip || (!clip.url.trim() && clip.start === null && clip.end === null);
}

/** What's wrong with a word's clip, as the end of a sentence. Null when it's ready to play. */
export function clipProblem(clip: DeckClip): string | null {
  if (!parseYouTubeLink(clip.url)) return 'paste a YouTube link for the clip';
  if (clip.start === null || clip.end === null) return 'set when the clip starts and ends';
  if (clip.end <= clip.start) return 'make the clip end after it starts';
  if (clip.end - clip.start > MAX_CLIP_SECONDS) return `keep the clip to ${MAX_CLIP_SECONDS} seconds or less`;
  return null;
}

/** What the TV plays, or null for a word with no clip. Only called on a deck with no problems. */
export function clipToPlay(clip: DeckClip | undefined): WordClip | null {
  if (!clip || clipIsEmpty(clip) || clipProblem(clip)) return null;
  return { video: parseYouTubeLink(clip.url)!.video, start: clip.start!, end: clip.end! };
}

/** What's still needed before this deck can be played. Empty means it's ready. */
export function deckProblems(content: DeckContent): string[] {
  const problems: string[] = [];
  if (!cleanName(content.title)) problems.push('Give the deck a title.');
  if (Array.from(cleanName(content.title)).length > MAX_DECK_TITLE) {
    problems.push(`Shorten the title to ${MAX_DECK_TITLE} characters.`);
  }
  if (content.theme.accent && !accentIsReadable(content.theme.accent)) {
    problems.push('Choose a darker accent colour, because this one is too pale to read on paper.');
  }
  const country = findCountry(content.region.country);
  if (!country) problems.push('Choose a country for the map.');

  (content.tips ?? []).forEach((tip, index) => {
    const where = `Trip tip ${index + 1}`;
    const heading = cleanName(tip.heading);
    if (!heading) problems.push(`${where}: add a heading, such as "Best bite".`);
    if (Array.from(heading).length > MAX_TIP_HEADING) {
      problems.push(`${where}: shorten the heading to ${MAX_TIP_HEADING} characters.`);
    }
    const text = cleanName(tip.text);
    if (!text && tip.places.length === 0) problems.push(`${where}: add the tip, or a place.`);
    if (Array.from(text).length > MAX_TIP_TEXT) problems.push(`${where}: shorten the tip to ${MAX_TIP_TEXT} characters.`);
    tip.places.forEach((place, number) => {
      if (!isMapLink(place.url)) problems.push(`${where}, place ${number + 1}: use a Google Maps link.`);
    });
  });

  const hasContent = content.games.some((game) => game.items.length > 0);
  if (!hasContent) problems.push('Add at least one word or photo.');

  const counts: Partial<Record<DeckGame['type'], number>> = {};
  for (const game of content.games) {
    counts[game.type] = (counts[game.type] ?? 0) + 1;
  }
  const seen: Partial<Record<DeckGame['type'], number>> = {};
  for (const game of content.games) {
    seen[game.type] = (seen[game.type] ?? 0) + 1;
    const label = GAME_LABELS[game.type];
    // Only needs a number when a deck plays the same game twice.
    const name = counts[game.type]! > 1 ? `${label.name} (${seen[game.type]})` : label.name;

    if (game.type === 'define') {
      game.items.forEach((item, index) => {
        const where = `${name}, word ${index + 1}`;
        const word = cleanName(item.word);
        const definition = cleanName(item.definition);
        if (!word) problems.push(`${where}: add the word.`);
        if (Array.from(word).length > MAX_WORD) problems.push(`${where}: shorten it to ${MAX_WORD} characters.`);
        const wrong = answerProblem(definition);
        if (wrong === 'empty') problems.push(`${where}: add the real definition.`);
        if (wrong === 'too_long') {
          problems.push(`${where}: shorten the definition to ${MAX_ANSWER_LENGTH} characters.`);
        }
        const clip = item.clip && !clipIsEmpty(item.clip) ? clipProblem(item.clip) : null;
        if (clip) problems.push(`${where}: ${clip}.`);
      });
    }

    if (game.type === 'geo') {
      game.items.forEach((item, index) => {
        const where = `${name}, photo ${index + 1}`;
        const place = cleanName(item.label);
        if (!place) problems.push(`${where}: name the place.`);
        if (Array.from(place).length > MAX_PLACE_LABEL) {
          problems.push(`${where}: shorten the place name to ${MAX_PLACE_LABEL} characters.`);
        }
        if (item.lat === null || item.lng === null) {
          problems.push(`${where}: set the location.`);
        } else if (country && !insideCountry(country, item.lat, item.lng)) {
          problems.push(`${where}: the location is outside ${country.name}, so nobody could guess it.`);
        }
      });
    }

    if (game.type === 'choice') {
      game.items.forEach((item, index) => {
        const where = `${name}, photo ${index + 1}`;
        if (Array.from(cleanName(item.question)).length > MAX_QUESTION) {
          problems.push(`${where}: shorten the question to ${MAX_QUESTION} characters.`);
        }
        const options = item.options.map(cleanName);
        options.forEach((option, position) => {
          const letter = choiceLetter(position);
          if (!option) problems.push(`${where}: fill in answer ${letter}.`);
          if (Array.from(option).length > MAX_CHOICE) {
            problems.push(`${where}: shorten answer ${letter} to ${MAX_CHOICE} characters.`);
          }
        });
        // "Kyoto" and "kyoto." are the same answer to anyone reading the TV.
        const keys = options.filter(Boolean).map((option) => nameKey(option) || option);
        if (new Set(keys).size < keys.length) problems.push(`${where}: make the four answers different.`);
      });
    }
  }
  return problems;
}
