import { describe, expect, it } from 'vitest';
import { deckToSetup } from '../../server/decks.js';
import { Room, type RoomSetup } from '../../server/session/room.js';
import { deckContentSchema, deckProblems, emptyDeck, imagesInDeck, MAX_EXTRA_PHOTOS, type DeckContent } from '../../shared/deck.js';
import type { GuestScreen, HostScreen } from '../../shared/protocol.js';

const PHOTO = 'a'.repeat(22);
const OTHER = 'b'.repeat(22);
const EXTRA = (n: number) => String.fromCharCode(99 + n).repeat(22);
const KYOTO = { lat: 35.0116, lng: 135.7681 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };

type HostGallery = Extract<HostScreen, { kind: 'gallery' }>;
type GuestGallery = Extract<GuestScreen, { kind: 'gallery' }>;

function deckWith(games: DeckContent['games']): DeckContent {
  return { ...emptyDeck(), title: 'Japan 2026', games };
}

function started(setup: RoomSetup) {
  const room = new Room('room', setup, 0);
  const outcome = room.join('hash-alex', 'Alex', 1);
  if (outcome.kind !== 'joined') throw new Error('expected to join');
  room.connect(outcome.playerId, 1);
  return { room, id: outcome.playerId };
}

/** Plays the night straight through, with nobody answering, and lists each screen once. */
function screensOf(room: Room): string[] {
  const kinds: string[] = [];
  let now = 10;
  for (let press = 0; press < 60; press += 1) {
    const kind = room.hostView().screen.kind;
    if (kinds.at(-1) !== kind) kinds.push(kind);
    if (kind === 'final') break;
    now += 400_000;
    if (room.hasRunningTimer) room.tick(now);
    else room.next(room.screenId, now);
  }
  return kinds;
}

describe('extra photos in a deck', () => {
  it(`takes up to ${MAX_EXTRA_PHOTOS} for a caption or map photo, and none is fine too`, () => {
    const extras = Array.from({ length: MAX_EXTRA_PHOTOS }, (_, n) => EXTRA(n));
    const deck = deckWith([
      { type: 'caption', settings: {}, items: [{ image: PHOTO, extras }, { image: OTHER }] },
      { type: 'geo', settings: {}, items: [{ image: OTHER, label: 'Kyoto', ...KYOTO, extras: [EXTRA(0)] }] },
    ]);
    expect(deckContentSchema.safeParse(deck).success).toBe(true);
    expect(deckProblems(deck)).toEqual([]);
  });

  it('refuses one too many, and a name with a path in it', () => {
    const tooMany = Array.from({ length: MAX_EXTRA_PHOTOS + 1 }, (_, n) => EXTRA(n));
    const many = deckWith([{ type: 'caption', settings: {}, items: [{ image: PHOTO, extras: tooMany }] }]);
    const sneaky = deckWith([{ type: 'caption', settings: {}, items: [{ image: PHOTO, extras: ['../../etc/passwd'] }] }]);
    expect(deckContentSchema.safeParse(many).success).toBe(false);
    expect(deckContentSchema.safeParse(sneaky).success).toBe(false);
  });

  it('counts them as photos the deck uses, so they are kept and exported with it', () => {
    const deck = deckWith([
      { type: 'geo', settings: {}, items: [{ image: PHOTO, label: 'x', lat: null, lng: null, extras: [EXTRA(0)] }] },
      { type: 'caption', settings: {}, items: [{ image: OTHER, extras: [EXTRA(1), EXTRA(2)] }] },
    ]);
    expect(imagesInDeck(deck)).toEqual([PHOTO, EXTRA(0), OTHER, EXTRA(1), EXTRA(2)]);
  });

  it('carries them into the game', () => {
    const setup = deckToSetup(
      deckWith([
        { type: 'caption', settings: {}, items: [{ image: PHOTO, extras: [EXTRA(0)] }, { image: OTHER }] },
        { type: 'geo', settings: {}, items: [{ image: OTHER, label: 'Kyoto', ...KYOTO, extras: [EXTRA(1)] }] },
      ]),
    );
    expect(setup.games[0]).toMatchObject({ items: [{ image: PHOTO, extras: [EXTRA(0)] }, { image: OTHER, extras: [] }] });
    expect(setup.games[1]).toMatchObject({ items: [{ image: OTHER, label: 'Kyoto', extras: [EXTRA(1)] }] });
  });
});

describe('the gallery after a round', () => {
  it('follows a map photo with extras, and only that one', () => {
    const { room } = started({
      title: 'Test',
      country: 'Japan',
      games: [
        {
          type: 'geo',
          items: [
            { image: PHOTO, label: 'Kyoto', ...KYOTO, extras: [EXTRA(0), EXTRA(1)] },
            { image: OTHER, label: 'Tokyo', ...TOKYO },
          ],
        },
      ],
    });
    expect(screensOf(room)).toEqual([
      'lobby',
      'title',
      'guess',
      'pinReveal',
      'gallery',
      'guess',
      'pinReveal',
      'standings',
      'final',
    ]);
  });

  it('follows a caption photo with extras, after the winner is shown', () => {
    const { room } = started({
      title: 'Test',
      games: [{ type: 'caption', items: [{ image: PHOTO, extras: [EXTRA(0)] }, { image: OTHER }] }],
    });
    const screens = screensOf(room);
    const gallery = screens.indexOf('gallery');
    expect(gallery).toBeGreaterThan(0);
    expect(screens[gallery - 1]).toBe('reveal');
    expect(screens.filter((kind) => kind === 'gallery')).toHaveLength(1);
    expect(screens.at(-2)).toBe('standings');
  });

  it('shows the TV the photos and the place, and tells phones how many there are', () => {
    const { room, id } = started({
      title: 'Test',
      country: 'Japan',
      games: [{ type: 'geo', items: [{ image: PHOTO, label: 'Kyoto', ...KYOTO, extras: [EXTRA(0), EXTRA(1)] }] }],
    });
    // Lobby, title, the guess (timed, so skipped twice), then the reveal.
    room.next(room.screenId, 2);
    room.next(room.screenId, 3);
    room.skipTimer(room.screenId, 4);
    room.skipTimer(room.screenId, 4);
    expect(room.hostView().screen.kind).toBe('pinReveal');
    // Long after the reveal has finished, so one press moves on.
    room.next(room.screenId, 100_000);

    const host = room.hostView().screen as HostGallery;
    expect(host).toMatchObject({ kind: 'gallery', images: [EXTRA(0), EXTRA(1)], place: 'Kyoto' });
    expect(host.round).toMatchObject({ game: 'geo', number: 1, count: 1, image: PHOTO });
    expect(room.hostView().canAdvance).toBe(true);

    const guest = room.guestView(id)!.screen as GuestGallery;
    expect(guest).toEqual({ kind: 'gallery', round: host.round, count: 2 });
  });

  it('comes back on the same gallery after a restart', () => {
    const { room } = started({
      title: 'Test',
      games: [{ type: 'caption', items: [{ image: PHOTO, extras: [EXTRA(0)] }] }],
    });
    let now = 10;
    while (room.hostView().screen.kind !== 'gallery') {
      now += 400_000;
      if (room.hasRunningTimer) room.tick(now);
      else room.next(room.screenId, now);
    }
    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())))!;
    expect(restored.hostView().screen).toMatchObject({ kind: 'gallery', images: [EXTRA(0)], place: null });
  });
});
