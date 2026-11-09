import { describe, expect, it } from 'vitest';
import { PinRound } from '../../server/games/pin.js';
import { Room, type RoomSetup } from '../../server/session/room.js';
import { PIN_REVEAL, pinNameTimes, pinRevealMs } from '../../shared/reveal.js';
import type { GuestScreen, HostScreen } from '../../shared/protocol.js';
import { baseStyle, streetLayers, viewLimits } from '../../client/src/map/streets.js';

const KYOTO = { lat: 35.0116, lng: 135.7681 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };
const SAPPORO = { lat: 43.0618, lng: 141.3545 };
const ROME = { lat: 41.9, lng: 12.5 };

function pinRound(): PinRound {
  return new PinRound({
    place: { ...KYOTO, label: 'Kyoto', image: 'photo' },
    guessMs: 45_000,
    maxPoints: 1000,
    scaleKm: 300,
    allowed: (spot) => spot.lng > 100,
  });
}

describe('a pin round', () => {
  it('keeps one current pin per guest, and a move replaces it', () => {
    const round = pinRound();
    round.place('a', TOKYO.lat, TOKYO.lng);
    round.place('a', KYOTO.lat, KYOTO.lng);
    expect(round.pinOf('a')).toEqual({ lat: 35.0116, lng: 135.7681 });
    expect(round.pinnedIds()).toEqual(['a']);
  });

  it('refuses a pin outside the country, and leaves the old one in place', () => {
    const round = pinRound();
    round.place('a', TOKYO.lat, TOKYO.lng);
    expect(round.place('a', ROME.lat, ROME.lng)).toEqual({ ok: false, code: 'outside_country' });
    expect(round.pinOf('a')).toEqual({ lat: TOKYO.lat, lng: TOKYO.lng });
  });

  it('ignores repeats and older messages', () => {
    const round = pinRound();
    const place = (seq: number, spot: typeof KYOTO) => round.act('a', seq, () => round.place('a', spot.lat, spot.lng));
    expect(place(2, TOKYO)).toEqual({ ok: true });
    expect(place(2, SAPPORO)).toEqual({ ok: true });
    expect(round.pinOf('a')).toEqual({ lat: TOKYO.lat, lng: TOKYO.lng });
    expect(place(1, SAPPORO)).toEqual({ ok: false, code: 'stale_action' });
    expect(round.pinOf('a')).toEqual({ lat: TOKYO.lat, lng: TOKYO.lng });
    expect(round.lastSeq('a')).toBe(2);
  });

  it('scores full marks on the spot and less with distance', () => {
    const round = pinRound();
    round.place('close', KYOTO.lat, KYOTO.lng);
    round.place('far', SAPPORO.lat, SAPPORO.lng);
    const results = round.resolve();
    expect(results.get('close')).toEqual({ km: 0, points: 1000 });
    expect(results.get('far')!.km).toBeGreaterThan(900);
    expect(results.get('far')!.points).toBeLessThan(50);
    expect(round.resultOf('nobody')).toBeNull();
  });

  it('scores only once', () => {
    const round = pinRound();
    round.place('a', KYOTO.lat, KYOTO.lng);
    const first = round.resolve();
    round.place('b', KYOTO.lat, KYOTO.lng);
    expect(round.resolve()).toBe(first);
    expect(first.has('b')).toBe(false);
  });

  it('lists pins closest first, without anyone removed', () => {
    const round = pinRound();
    round.place('far', SAPPORO.lat, SAPPORO.lng);
    round.place('close', KYOTO.lat, KYOTO.lng);
    round.place('gone', TOKYO.lat, TOKYO.lng);
    round.resolve();
    const pins = round.revealPins((id) => (id === 'gone' ? null : id.toUpperCase()));
    expect(pins.map((pin) => pin.name)).toEqual(['CLOSE', 'FAR']);
  });

  it('survives being saved and restored', () => {
    const round = pinRound();
    round.act('a', 3, () => round.place('a', TOKYO.lat, TOKYO.lng));
    round.markLeftPage('a');
    round.resolve();
    const state = PinRound.parseState(JSON.parse(JSON.stringify(round.toState())))!;
    const restored = new PinRound(round.config, state);
    expect(restored.resolved).toBe(true);
    expect(restored.pinOf('a')).toEqual({ lat: TOKYO.lat, lng: TOKYO.lng });
    expect(restored.lastSeq('a')).toBe(3);
    expect(restored.hasLeftPage('a')).toBe(true);
  });

  it('refuses a damaged state', () => {
    expect(PinRound.parseState({ pins: 'nope' })).toBeNull();
  });
});

describe('the reveal timing', () => {
  it('lands the closest name last', () => {
    const times = pinNameTimes(3);
    expect(times[0]).toBeGreaterThan(times[1]!);
    expect(times[1]).toBeGreaterThan(times[2]!);
    expect(times[2]).toBe(PIN_REVEAL.namesAtMs);
  });

  it('caps the rows, however many pins there are', () => {
    expect(pinNameTimes(50)).toHaveLength(PIN_REVEAL.rows);
    expect(pinRevealMs(50)).toBe(pinRevealMs(PIN_REVEAL.rows));
  });

  it('still flies to the spot with no pins at all', () => {
    expect(pinNameTimes(0)).toEqual([]);
    expect(pinRevealMs(0)).toBe(PIN_REVEAL.flyAtMs + PIN_REVEAL.flyMs);
  });
});

const IMAGE = 'a'.repeat(22);
const setup: RoomSetup = {
  title: 'Test',
  country: 'Japan',
  games: [
    {
      type: 'geo',
      settings: { guessMs: 30_000 },
      items: [
        { image: IMAGE, label: 'Kyoto', ...KYOTO },
        { image: IMAGE, label: 'Tokyo', ...TOKYO },
      ],
    },
  ],
};

/** The first press is "time's up", with a grace period, and the second moves straight on. */
function endGuess(room: Room, now: number): void {
  room.skipTimer(room.screenId, now);
  room.skipTimer(room.screenId, now);
}

function started(players = ['Alex', 'Sam']) {
  const room = new Room('room', setup, 0);
  const ids = players.map((name, index) => {
    const outcome = room.join(`hash-${index}`, name, 1);
    if (outcome.kind !== 'joined') throw new Error('expected to join');
    room.connect(outcome.playerId, 1);
    return outcome.playerId;
  });
  // The lobby, then the title card.
  room.next(room.screenId, 2);
  room.next(room.screenId, 3);
  return { room, ids };
}

type HostGuess = Extract<HostScreen, { kind: 'guess' }>;
type HostReveal = Extract<HostScreen, { kind: 'pinReveal' }>;
type GuestGuess = Extract<GuestScreen, { kind: 'guess' }>;
type GuestReveal = Extract<GuestScreen, { kind: 'pinReveal' }>;

describe('Where was this? in a room', () => {
  it('runs photo, reveal, photo, reveal, standings, final', () => {
    const { room, ids } = started();
    const kinds: string[] = [];
    let now = 10;
    for (let step = 0; step < 6; step += 1) {
      kinds.push(room.hostView().screen.kind);
      now += 100_000;
      if (room.hasRunningTimer) room.tick(now);
      else room.next(room.screenId, now);
    }
    expect(kinds).toEqual(['guess', 'pinReveal', 'guess', 'pinReveal', 'standings', 'final']);
    expect(ids).toHaveLength(2);
  });

  it('tells nobody the real spot during the guess, and only at the reveal', () => {
    const { room, ids } = started();
    expect(JSON.stringify(room.hostView())).not.toContain('Kyoto');
    expect(JSON.stringify(room.hostView())).not.toContain('135.76');
    expect(JSON.stringify(room.guestView(ids[0]!))).not.toContain('Kyoto');
    expect(JSON.stringify(room.guestView(ids[0]!))).not.toContain('135.76');
    endGuess(room, 10);
    expect((room.hostView().screen as HostReveal).target).toEqual({ ...KYOTO, label: 'Kyoto' });
  });

  it("never shows a guest anyone else's pin", () => {
    const { room, ids } = started();
    room.submitPin(ids[0]!, room.screenId, 1, TOKYO.lat, TOKYO.lng, 10);
    expect((room.guestView(ids[1]!)!.screen as GuestGuess).pin).toBeNull();
    expect(JSON.stringify(room.guestView(ids[1]!))).not.toContain(String(TOKYO.lng));
    // The TV only learns who's in, not where.
    expect((room.hostView().screen as HostGuess).doneIds).toEqual([ids[0]]);
    expect(JSON.stringify(room.hostView())).not.toContain(String(TOKYO.lng));
  });

  it('refuses a pin outside Japan, using the exact outline', () => {
    const { room, ids } = started();
    expect(room.submitPin(ids[0]!, room.screenId, 1, 35.18, 129.07, 10)).toEqual({ ok: false, code: 'outside_country' });
    expect((room.guestView(ids[0]!)!.screen as GuestGuess).pin).toBeNull();
  });

  it('adds the points to the score, once', () => {
    const { room, ids } = started();
    room.submitPin(ids[0]!, room.screenId, 1, KYOTO.lat, KYOTO.lng, 10);
    room.submitPin(ids[1]!, room.screenId, 1, TOKYO.lat, TOKYO.lng, 10);
    endGuess(room, 11);
    const screen = room.hostView().screen as HostReveal;
    expect(screen.kind).toBe('pinReveal');
    expect(screen.pins.map((pin) => pin.name)).toEqual(['Alex', 'Sam']);
    expect(screen.pins[0]!.points).toBe(1000);
    const result = (room.guestView(ids[0]!)!.screen as GuestReveal).result;
    expect(result).toEqual({ km: 0, points: 1000, total: 1000, rank: 1 });
    expect((room.guestView(ids[1]!)!.screen as GuestReveal).result.rank).toBe(2);
  });

  it('gives no points and a clear result to a guest with no pin', () => {
    const { room, ids } = started();
    endGuess(room, 10);
    const result = (room.guestView(ids[0]!)!.screen as GuestReveal).result;
    expect(result.km).toBeNull();
    expect(result.points).toBe(0);
    expect((room.hostView().screen as HostReveal).pins).toEqual([]);
  });

  it('drops to the final seconds once everyone has a pin', () => {
    const { room, ids } = started();
    for (const id of ids) room.submitPin(id, room.screenId, 1, KYOTO.lat, KYOTO.lng, 10);
    expect(room.tick(20)).toBe('changed');
    expect((room.hostView().screen as HostGuess).timer.endsAt).toBe(5020);
  });

  it('refuses a late pin, or one for another screen', () => {
    const { room, ids } = started();
    const { screenId } = room;
    expect(room.submitPin(ids[0]!, screenId + 1, 1, KYOTO.lat, KYOTO.lng, 10)).toEqual({ ok: false, code: 'too_late' });
    // Past the deadline and the grace period, but before the next tick.
    expect(room.submitPin(ids[0]!, screenId, 2, KYOTO.lat, KYOTO.lng, 40_000)).toEqual({ ok: false, code: 'too_late' });
    room.tick(40_000);
    expect(room.submitPin(ids[0]!, screenId, 3, KYOTO.lat, KYOTO.lng, 40_001)).toEqual({ ok: false, code: 'too_late' });
  });

  it('holds on the reveal for a first Space, then moves on', () => {
    const { room } = started();
    endGuess(room, 10);
    const screen = room.screenId;
    room.next(screen, 20);
    expect(room.screenId).toBe(screen);
    expect((room.hostView().screen as HostReveal).endsAt).toBe(20);
    room.next(screen, 30);
    expect(room.screenId).toBe(screen + 1);
  });

  it('removes a removed guest from the reveal and the round', () => {
    const { room, ids } = started();
    room.submitPin(ids[0]!, room.screenId, 1, KYOTO.lat, KYOTO.lng, 10);
    room.submitPin(ids[1]!, room.screenId, 1, TOKYO.lat, TOKYO.lng, 10);
    room.remove(ids[0]!, 11);
    expect((room.hostView().screen as HostGuess).doneIds).toEqual([ids[1]]);
    endGuess(room, 12);
    expect((room.hostView().screen as HostReveal).pins.map((pin) => pin.name)).toEqual(['Sam']);
  });

  it('counts this game in the standings', () => {
    const { room, ids } = started(['Alex']);
    room.submitPin(ids[0]!, room.screenId, 1, KYOTO.lat, KYOTO.lng, 10);
    endGuess(room, 11);
    room.next(room.screenId, 20);
    room.next(room.screenId, 21);
    endGuess(room, 22);
    room.next(room.screenId, 30);
    room.next(room.screenId, 31);
    const screen = room.hostView().screen;
    if (screen.kind !== 'standings') throw new Error(`expected standings, got ${screen.kind}`);
    expect(screen.game).toBe('geo');
    expect(screen.rows[0]).toMatchObject({ score: 1000, previous: 0 });
  });

  it('carries the map country to every client, so the map can be fetched early', () => {
    const { room, ids } = started();
    expect(room.hostView().mapArea?.name).toBe('Japan');
    expect(room.guestView(ids[0]!)!.mapArea?.name).toBe('Japan');
  });

  it('has no map country without a map game', () => {
    const room = new Room('room', { title: 'Test', games: [{ type: 'define', items: [] }] }, 0);
    expect(room.hostView().mapArea).toBeNull();
  });

  it('leaves out a map game with no photos', () => {
    const room = new Room('room', { title: 'Test', games: [{ type: 'geo', items: [] }] }, 0);
    expect(room.hostView().mapArea).toBeNull();
  });

  describe('after a restart', () => {
    const restore = (room: Room, now: number) => Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())), now)!;

    it('keeps pins, and restarts the timer', () => {
      const { room, ids } = started();
      room.submitPin(ids[0]!, room.screenId, 1, TOKYO.lat, TOKYO.lng, 10);
      const restored = restore(room, 5000);
      const screen = restored.guestView(ids[0]!)!.screen as GuestGuess;
      expect(screen.pin).toEqual({ lat: TOKYO.lat, lng: TOKYO.lng });
      expect(screen.lastSeq).toBe(1);
      expect(screen.timer.endsAt).toBe(35_000);
    });

    it('never scores a reveal twice', () => {
      const { room, ids } = started(['Alex']);
      room.submitPin(ids[0]!, room.screenId, 1, KYOTO.lat, KYOTO.lng, 10);
      endGuess(room, 11);
      const restored = restore(room, 5000);
      const screen = restored.hostView().screen as HostReveal;
      expect(screen.kind).toBe('pinReveal');
      expect(screen.endsAt).toBe(5000);
      expect((restored.guestView(ids[0]!)!.screen as GuestReveal).result.total).toBe(1000);
    });

    it('refuses a snapshot with the wrong number of photos', () => {
      const { room } = started();
      expect(Room.fromSnapshot({ ...room.toSnapshot(), pinRounds: [] })).toBeNull();
    });
  });
});

describe('the map limits', () => {
  const box = [123.18, 23.77, 146.33, 46.01] as const;
  const padding = { top: 24, left: 24, right: 24, bottom: 152 };

  it('always contains the country', () => {
    for (const [width, height] of [
      [390, 700],
      [320, 500],
      [800, 300],
    ] as const) {
      const [west, south, east, north] = viewLimits(box, width, height, padding);
      expect(west).toBeLessThanOrEqual(box[0]);
      expect(east).toBeGreaterThanOrEqual(box[2]);
      expect(south).toBeLessThanOrEqual(box[1]);
      expect(north).toBeGreaterThanOrEqual(box[3]);
    }
  });

  it('leaves extra room on a tall phone, so all of Japan fits on it', () => {
    const [west, , east] = viewLimits(box, 390, 700, padding);
    const [tallWest, , tallEast] = viewLimits(box, 320, 900, padding);
    expect(tallEast - tallWest).toBeGreaterThanOrEqual(east - west - 1);
  });

  it('stays off the poles', () => {
    const [, south, , north] = viewLimits([-180, -80, 180, 83], 390, 700, padding);
    expect(south).toBeGreaterThanOrEqual(-85);
    expect(north).toBeLessThanOrEqual(85);
  });
});

describe('the street style', () => {
  const remote = {
    version: 8 as const,
    sources: {},
    layers: [
      { id: 'background', type: 'background' as const, paint: { 'background-color': '#fff' } },
      { id: 'water', type: 'fill' as const, source: 'x', 'source-layer': 'water', paint: { 'fill-color': '#000' } },
      {
        id: 'label_city',
        type: 'symbol' as const,
        source: 'x',
        'source-layer': 'place',
        layout: { 'text-field': '{name}' },
      },
    ],
  };

  it('leaves out its background, recolours and uses readable labels', () => {
    const layers = streetLayers(remote);
    expect(layers.map((layer) => layer.id)).toEqual(['water', 'label_city']);
    expect((layers[0] as unknown as { paint: Record<string, string> }).paint['fill-color']).toBe('#C7D3D0');
    expect(JSON.stringify((layers[1] as { layout: unknown }).layout)).toContain('name:en');
  });

  it('draws the country with nothing from the network', () => {
    const style = baseStyle({ polygons: [[[[1, 1], [2, 1], [2, 2], [1, 1]]]] });
    expect(JSON.stringify(style)).not.toContain('http');
    expect(style.layers.map((layer) => layer.id)).toEqual(['background', 'country-fill', 'country-edge']);
  });
});
