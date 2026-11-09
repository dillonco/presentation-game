import { describe, expect, it } from 'vitest';
import { deckToSetup } from '../../server/decks.js';
import { lookUpPlace, placeFromMapUrl } from '../../server/places.js';
import { Room } from '../../server/session/room.js';
import { deckContentSchema, deckProblems, emptyDeck, imagesInDeck, isMapLink, type DeckContent, type DeckTip } from '../../shared/deck.js';
import { tipsAsText } from '../../client/src/ui/tips.js';

const PHOTO = 'a'.repeat(22);
const SHORT = 'https://maps.app.goo.gl/Ab3dEfGh5JkLmN7pQ';
const FULL =
  'https://www.google.com/maps/place/Bar+Nami!/@34.388958,132.4498703,17z/data=!3m1!4b1!4m6!3m5!1s0x355aa26b9a52c215:0x49b26ae77dfdf321!8m2!3d34.388958!4d132.4498703!16s%2Fg%2F1v26jzb6?entry=tts';
/** The camera here is zoomed far out over the sea, nowhere near the pin. */
const ZOOMED_OUT =
  'https://www.google.com/maps/place/Kiyo%E2%80%99s+Kitchen/@36.1255591,135.1711397,8z/data=!3m1!5s0x60188bfbd91993eb:0x73e0693562fc525a!4m6!3m5!1s0x60188bfbf5cb32b5:0x7ec63789e70fa29b!8m2!3d35.6822201!4d139.7674829!16s%2Fg%2F1tdxv__x';

const NAMI = { name: 'Bar Nami!', url: SHORT, lat: 34.388958, lng: 132.44987 };

function tip(overrides: Partial<DeckTip> = {}): DeckTip {
  return { heading: 'Best bar', text: 'Nami, for live music', places: [NAMI], image: null, ...overrides };
}

function deckWith(tips: DeckTip[] | undefined): DeckContent {
  return {
    ...emptyDeck(),
    title: 'Japan 2026',
    games: [{ type: 'define', settings: {}, items: [{ word: 'komorebi', definition: 'Sunlight through leaves' }] }],
    tips,
  };
}

describe('reading a Google Maps address', () => {
  it("takes the pin's spot over the camera's, and the place's name", () => {
    expect(placeFromMapUrl(ZOOMED_OUT)).toEqual({ name: 'Kiyo’s Kitchen', lat: 35.68222, lng: 139.767483 });
    expect(placeFromMapUrl(FULL)).toEqual({ name: 'Bar Nami!', lat: 34.388958, lng: 132.44987 });
  });

  it('falls back to the camera, or a query of coordinates', () => {
    expect(placeFromMapUrl('https://www.google.com/maps/place/Somewhere/@35.1,139.2,15z')).toEqual({
      name: 'Somewhere',
      lat: 35.1,
      lng: 139.2,
    });
    expect(placeFromMapUrl('https://www.google.com/maps/search/?api=1&query=35.5,139.5')).toEqual({
      name: '',
      lat: 35.5,
      lng: 139.5,
    });
    expect(placeFromMapUrl('https://www.google.com/maps')).toBeNull();
  });

  it('only accepts links that open Google Maps', () => {
    expect(isMapLink(SHORT)).toBe(true);
    expect(isMapLink(FULL)).toBe(true);
    expect(isMapLink('http://maps.app.goo.gl/abc')).toBe(false);
    expect(isMapLink('https://www.google.com/search?q=nami')).toBe(false);
    expect(isMapLink('https://maps.app.goo.gl.example.com/abc')).toBe(false);
    expect(isMapLink('javascript:alert(1)')).toBe(false);
  });
});

describe('looking up a short link', () => {
  const redirectTo = (location: string) => async () => new Response(null, { status: 302, headers: { location } });

  it('follows the short link once and keeps it as the place to open', async () => {
    const found = await lookUpPlace(SHORT, redirectTo(FULL) as typeof fetch);
    expect(found).toEqual({ ok: true, place: NAMI });
  });

  it("won't follow a short link anywhere but Google Maps", async () => {
    const found = await lookUpPlace(SHORT, redirectTo('https://example.com/maps/place/x/@1,2,3z') as typeof fetch);
    expect(found).toEqual({ ok: false, error: 'place_not_found' });
  });

  it('refuses anything that is not a map link without fetching it', async () => {
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      return new Response(null);
    }) as typeof fetch;
    expect(await lookUpPlace('https://example.com/', spy)).toEqual({ ok: false, error: 'not_a_map_link' });
    expect(fetched).toBe(false);
  });
});

describe('trip tips in a deck', () => {
  it('loads decks made before tips existed', () => {
    expect(deckContentSchema.safeParse(deckWith(undefined)).success).toBe(true);
    expect(deckProblems(deckWith(undefined))).toEqual([]);
  });

  it('needs a heading, and a tip or a place', () => {
    const deck = deckWith([tip(), tip({ heading: ' ', text: '', places: [] })]);
    expect(deckProblems(deck)).toEqual(['Trip tip 2: add a heading, such as "Best bite".', 'Trip tip 2: add the tip, or a place.']);
  });

  it('refuses a place whose link opens somewhere else', () => {
    const deck = deckWith([tip({ places: [{ ...NAMI, url: 'https://example.com' }] })]);
    expect(deckProblems(deck)).toEqual(['Trip tip 1, place 1: use a Google Maps link.']);
  });

  it("counts a tip's photo as the deck's, so deleting another deck keeps it", () => {
    expect(imagesInDeck(deckWith([tip({ image: PHOTO })]))).toEqual([PHOTO]);
  });
});

describe('the tips page in a game', () => {
  function playToEnd(content: DeckContent) {
    const room = new Room('room', deckToSetup(content), 0);
    const outcome = room.join('hash-alex', 'Alex', 1);
    if (outcome.kind !== 'joined') throw new Error('expected to join');
    room.connect(outcome.playerId, 1);
    const kinds: string[] = [];
    let now = 10;
    for (let press = 0; press < 40; press += 1) {
      const kind = room.hostView().screen.kind;
      if (kinds.at(-1) !== kind) kinds.push(kind);
      now += 400_000;
      if (room.hasRunningTimer) room.tick(now);
      else if (!room.next(room.screenId, now).ok) break;
    }
    return { room, kinds, playerId: outcome.playerId };
  }

  it('comes after the podium, on the TV and every phone, and ends the night', () => {
    const { room, kinds, playerId } = playToEnd(deckWith([tip({ heading: '  Best   bar ' })]));
    expect(kinds.slice(-2)).toEqual(['final', 'tips']);
    const expected = { kind: 'tips', tips: [{ ...tip(), heading: 'Best bar' }] };
    expect(room.hostView().screen).toEqual(expected);
    expect(room.guestView(playerId)?.screen).toEqual(expected);
    expect(room.hostView().canAdvance).toBe(false);
    expect(room.finished).toBe(true);
  });

  it('leaves the night ending on the podium when there are none', () => {
    expect(playToEnd(deckWith([])).kinds.at(-1)).toBe('final');
    expect(playToEnd(deckWith(undefined)).kinds.at(-1)).toBe('final');
  });
});

describe('copying the tips', () => {
  it('reads cleanly as plain text, with every link', () => {
    const text = tipsAsText('Japan 2026', [
      { heading: 'Best bar', text: 'Nami or Hoshi', places: [NAMI, { ...NAMI, name: 'Hoshi', url: 'https://maps.app.goo.gl/x' }], image: null },
      { heading: 'One tip', text: "It's hot spring to fall", places: [], image: null },
    ]);
    expect(text).toBe(
      [
        'Japan 2026',
        '',
        'Best bar: Nami or Hoshi',
        `  Bar Nami!: ${SHORT}`,
        '  Hoshi: https://maps.app.goo.gl/x',
        '',
        "One tip: It's hot spring to fall",
        '',
      ].join('\n'),
    );
  });
});
