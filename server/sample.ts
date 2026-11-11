import { readFile } from 'node:fs/promises';
import { sampleDeck, type CaptionGame, type ChoiceGame, type DeckContent, type GeoGame } from '../shared/deck.js';
import { cleanJpeg, newImageId, type MediaStore } from './media.js';

/** Beside the server in both a build and development, since the build copies them to dist/server. */
const FOLDER = new URL('./sample-photos/', import.meta.url);

/** The real spot each one shows, not where the photographer stood. */
const PLACES = [
  { file: 'shibuya', label: 'Shibuya Crossing, Tokyo', lat: 35.6595, lng: 139.7005 },
  { file: 'miyajima', label: 'Itsukushima Shrine, Miyajima', lat: 34.296, lng: 132.3197 },
  { file: 'himeji', label: 'Himeji Castle', lat: 34.8394, lng: 134.6939 },
] as const;

const CAPTIONS = ['deer', 'vending'] as const;

/** The first answer is the right one here. Each game shuffles them. */
const QUESTIONS = [
  { file: 'deer', question: "What do Nara's deer famously do for a cracker?", options: ['Bow', 'Dance', 'Sing', 'Roll over'] },
  {
    file: 'vending',
    question: 'About how many vending machines does Japan have?',
    options: ['4 million', '40,000', '400,000', '40 million'],
  },
] as const;

/** How many photos one copy of the sample adds, for a hosted space's limit. */
export const SAMPLE_PHOTO_COUNT = PLACES.length + CAPTIONS.length + QUESTIONS.length;

async function addPhoto(media: MediaStore, space: string, file: string): Promise<string> {
  const id = newImageId();
  for (const [variant, name] of [
    ['full', `${file}.jpg`],
    ['small', `${file}.small.jpg`],
  ] as const) {
    const clean = cleanJpeg(await readFile(new URL(name, FOLDER)));
    if (!clean) throw new Error(`Sample photo ${name} isn't a complete JPEG`);
    await media.save(id, variant, clean.body);
  }
  await media.claim(space, id);
  return id;
}

/**
 * The sample words plus a few free-to-use photos, so all four games can be tried while developing.
 * Only offered outside production: see `sampleDeck` in `server/app.ts`.
 * Each copy gets photos with fresh random ids, so nothing about a photo's address hints at the place,
 * and deleting one copy never takes photos from another.
 */
export async function sampleDeckWithPhotos(media: MediaStore, space: string): Promise<DeckContent> {
  const geo: GeoGame = { type: 'geo', settings: {}, items: [] };
  for (const place of PLACES) {
    geo.items.push({ image: await addPhoto(media, space, place.file), label: place.label, lat: place.lat, lng: place.lng });
  }
  const caption: CaptionGame = { type: 'caption', settings: {}, items: [] };
  for (const file of CAPTIONS) caption.items.push({ image: await addPhoto(media, space, file) });
  const choice: ChoiceGame = { type: 'choice', settings: {}, items: [] };
  for (const { file, question, options } of QUESTIONS) {
    choice.items.push({ image: await addPhoto(media, space, file), question, options: [...options], answer: 0 });
  }

  const words = sampleDeck();
  return { ...words, games: [...words.games, geo, caption, choice] };
}
