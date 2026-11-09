import { describe, expect, it } from 'vitest';
import { deckToSetup } from '../../server/decks.js';
import { accentColours, accentIsReadable, contrastRatio } from '../../shared/color.js';
import { COUNTRIES, findCountry, insideCountry } from '../../shared/countries.js';
import { deckContentSchema, deckProblems, emptyDeck, imagesInDeck, sampleDeck, type DeckContent } from '../../shared/deck.js';

const IMAGE = 'a'.repeat(22);
const OTHER_IMAGE = 'b'.repeat(22);

function deckWith(games: DeckContent['games']): DeckContent {
  return { ...emptyDeck(), title: 'Japan 2026', games };
}

describe('the deck format', () => {
  it('accepts a new deck and the sample deck', () => {
    expect(deckContentSchema.safeParse(emptyDeck()).success).toBe(true);
    expect(deckContentSchema.safeParse(sampleDeck()).success).toBe(true);
  });

  it('accepts unfinished work, so the builder can save as you type', () => {
    const draft = deckWith([{ type: 'define', settings: {}, items: [{ word: '', definition: '' }] }]);
    expect(deckContentSchema.safeParse(draft).success).toBe(true);
  });

  it.each([
    ['an unknown field', { ...emptyDeck(), surprise: true }],
    ['an unknown game', { ...emptyDeck(), games: [{ type: 'quiz', settings: {}, items: [] }] }],
    ['an accent that is not a colour', { ...emptyDeck(), theme: { accent: 'url(evil)' } }],
    ['a photo name with a path in it', deckWith([{ type: 'caption', settings: {}, items: [{ image: '../../etc/passwd' }] }])],
    ['a timer below the minimum', deckWith([{ type: 'define', settings: { writeSeconds: 1 }, items: [] }])],
    ['a location off the globe', deckWith([{ type: 'geo', settings: {}, items: [{ image: IMAGE, label: 'x', lat: 95, lng: 0 }] }])],
    ['too many words', deckWith([{ type: 'define', settings: {}, items: Array(31).fill({ word: 'a', definition: 'b' }) }])],
  ])('refuses %s', (_name, deck) => {
    expect(deckContentSchema.safeParse(deck).success).toBe(false);
  });
});

describe('whether a deck is ready to play', () => {
  it('passes a finished deck', () => {
    const deck = deckWith([
      { type: 'define', settings: {}, items: [{ word: 'komorebi', definition: 'Sunlight through leaves' }] },
      { type: 'geo', settings: {}, items: [{ image: IMAGE, label: 'Fushimi Inari', lat: 34.9671, lng: 135.7727 }] },
      { type: 'caption', settings: {}, items: [{ image: OTHER_IMAGE }] },
    ]);
    expect(deckProblems(deck)).toEqual([]);
  });

  it('asks for something to play', () => {
    expect(deckProblems(deckWith([]))).toContain('Add at least one word or photo.');
  });

  it('says exactly which word needs what', () => {
    const deck = deckWith([
      {
        type: 'define',
        settings: {},
        items: [
          { word: 'komorebi', definition: 'Sunlight' },
          { word: '  ', definition: 'Has no word' },
          { word: 'tsundoku', definition: '​' },
          { word: 'kuidaore', definition: 'x'.repeat(141) },
        ],
      },
    ]);
    expect(deckProblems(deck)).toEqual([
      'Define it, word 2: add the word.',
      'Define it, word 3: add the real definition.',
      'Define it, word 4: shorten the definition to 140 characters.',
    ]);
  });

  it('says exactly which photo needs what', () => {
    const deck = deckWith([
      {
        type: 'geo',
        settings: {},
        items: [
          { image: IMAGE, label: '', lat: 35, lng: 135 },
          { image: OTHER_IMAGE, label: 'Kyoto', lat: null, lng: null },
        ],
      },
    ]);
    expect(deckProblems(deck)).toEqual([
      'Where was this?, photo 1: name the place.',
      'Where was this?, photo 2: set the location.',
    ]);
  });

  it('refuses a location that nobody could guess', () => {
    const deck = deckWith([{ type: 'geo', settings: {}, items: [{ image: IMAGE, label: 'Rome', lat: 41.9, lng: 12.5 }] }]);
    expect(deckProblems(deck)).toEqual([
      'Where was this?, photo 1: the location is outside Japan, so nobody could guess it.',
    ]);
    expect(deckProblems({ ...deck, region: { country: 'Italy' } })).toEqual([]);
  });

  it('numbers a game only when the deck plays it twice', () => {
    const empty = { type: 'define', settings: {}, items: [{ word: '', definition: 'x' }] } as const;
    expect(deckProblems(deckWith([{ ...empty, items: [...empty.items] }, { ...empty, items: [...empty.items] }]))).toEqual([
      'Define it (1), word 1: add the word.',
      'Define it (2), word 1: add the word.',
    ]);
  });

  it('refuses an unreadable accent and an unknown country', () => {
    const deck = { ...sampleDeck(), theme: { accent: '#ffee99' }, region: { country: 'Atlantis' } };
    expect(deckProblems(deck)).toEqual([
      'Choose a darker accent colour, because this one is too pale to read on paper.',
      'Choose a country for the map.',
    ]);
  });
});

describe('turning a deck into a game', () => {
  it('leaves out empty games, so nobody sees a title card with nothing after it', () => {
    const setup = deckToSetup({
      ...sampleDeck(),
      games: [
        { type: 'geo', settings: {}, items: [] },
        { type: 'define', settings: {}, items: [{ word: 'komorebi', definition: 'Sunlight' }] },
        { type: 'caption', settings: {}, items: [] },
      ],
    });
    expect(setup.games.map((game) => game.type)).toEqual(['define']);
  });

  it('carries timers, points and moderation across', () => {
    const setup = deckToSetup({
      ...sampleDeck(),
      moderation: { blocklist: ['jerk'], similarity: 'strict', showLeftPage: false },
      games: [
        {
          type: 'define',
          settings: { writeSeconds: 30, voteSeconds: 20, findReal: 700 },
          items: [{ word: ' komorebi ', definition: '  Sunlight   through  leaves ' }],
        },
      ],
    });
    expect(setup).toMatchObject({ blocklist: ['jerk'], similarity: 'strict', showLeftPage: false });
    expect(setup.games[0]).toEqual({
      type: 'define',
      settings: { writeMs: 30_000, voteMs: 20_000, points: { findReal: 700 } },
      items: [{ word: 'komorebi', definition: 'Sunlight through leaves' }],
    });
  });

  it('gives an accent both a paper and a TV version', () => {
    const setup = deckToSetup({ ...sampleDeck(), theme: { accent: '#225577' } });
    expect(setup.accent).toEqual(accentColours('#225577'));
  });

  it('lists the photos a deck uses', () => {
    const deck = deckWith([
      { type: 'define', settings: {}, items: [] },
      { type: 'geo', settings: {}, items: [{ image: IMAGE, label: 'x', lat: null, lng: null }] },
      { type: 'caption', settings: {}, items: [{ image: OTHER_IMAGE }] },
    ]);
    expect(imagesInDeck(deck)).toEqual([IMAGE, OTHER_IMAGE]);
  });
});

describe('accent colours', () => {
  it('accepts the default persimmon and refuses a pale yellow', () => {
    expect(accentIsReadable('#a8452f')).toBe(true);
    expect(accentIsReadable('#ffee99')).toBe(false);
  });

  it.each(['#a8452f', '#000000', '#225577', '#7a1f6b', '#14532d'])('keeps %s readable on the TV', (hex) => {
    const { light, dark } = accentColours(hex);
    expect(light).toBe(hex);
    expect(contrastRatio(dark, '#1b1c1a')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('countries', () => {
  it('has the countries a trip might need, in order, each once', () => {
    const names = COUNTRIES.map((country) => country.name);
    expect(names).toEqual(expect.arrayContaining(['Japan', 'Italy', 'United States', 'New Zealand', 'Bosnia and Herzegovina']));
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('Antarctica');
  });

  it.each([
    ['Sapporo', 43.06, 141.35],
    ['Okinawa', 26.21, 127.68],
    ['Yonaguni', 24.47, 123.0 + 0.2],
    ['Ogasawara', 27.09, 142.19],
  ])('puts %s inside Japan', (_place, lat, lng) => {
    expect(insideCountry(findCountry('Japan')!, lat, lng)).toBe(true);
  });

  // A rough box only, which Seoul falls inside. The exact outline check comes with the map game.
  it.each([
    ['Beijing', 39.9, 116.4],
    ['Hawaii', 21.3, -157.85],
    ['London', 51.5, -0.12],
  ])('keeps %s outside Japan', (_place, lat, lng) => {
    expect(insideCountry(findCountry('Japan')!, lat, lng)).toBe(false);
  });

  it('counts far-off parts of a country, which the opening view leaves out', () => {
    const usa = findCountry('United States')!;
    expect(insideCountry(usa, 21.3, -157.85)).toBe(true); // Hawaii
    expect(insideCountry(usa, 61.2, -149.9)).toBe(true); // Alaska
  });

  it('handles a country that crosses the 180° line', () => {
    expect(insideCountry(findCountry('Fiji')!, -16.8, 179.9)).toBe(true);
    expect(insideCountry(findCountry('Fiji')!, -16.8, -179.9)).toBe(true);
  });
});
