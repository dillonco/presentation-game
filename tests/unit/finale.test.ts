import { describe, expect, it } from 'vitest';
import type { GuestScreen, HostScreen, HostView, RoundInfo } from '../../shared/protocol.js';
import { PODIUM, podiumPlan } from '../../shared/reveal.js';
import { Room, type RoomSetup } from '../../server/session/room.js';

type HostFinal = Extract<HostScreen, { kind: 'final' }>;
type GuestFinal = Extract<GuestScreen, { kind: 'final' }>;

describe('the podium timing', () => {
  it('builds the list from the bottom, then lands 3rd, 2nd and 1st', () => {
    const plan = podiumPlan([1, 2, 3], 7);
    expect(plan.listTimes).toHaveLength(7);
    // The bottom row first, so the list builds up towards the podium.
    for (let index = 1; index < 7; index += 1) expect(plan.listTimes[index - 1]).toBeGreaterThan(plan.listTimes[index]!);
    const { 1: first, 2: second, 3: third } = plan.medalTimes;
    expect(third).toBeGreaterThan(Math.max(...plan.listTimes));
    expect(second! - third!).toBe(PODIUM.medalGapMs);
    // A longer wait before 1st.
    expect(first! - second!).toBe(PODIUM.beforeWinnerMs);
    expect(plan.lastMs).toBe(first);
  });

  it('gives no beat to a place nobody holds', () => {
    // Two people tied for 1st, so there's no 2nd.
    const plan = podiumPlan([1, 3], 4);
    expect(plan.medalTimes[2]).toBeUndefined();
    expect(plan.medalTimes[1]! - plan.medalTimes[3]!).toBe(PODIUM.beforeWinnerMs);
  });

  it('starts straight on the podium when nobody is below it', () => {
    const plan = podiumPlan([1, 2], 0);
    expect(plan.listTimes).toEqual([]);
    expect(plan.medalTimes[2]).toBe(PODIUM.listAtMs);
    expect(podiumPlan([1], 0).medalTimes[1]).toBe(PODIUM.listAtMs);
    expect(podiumPlan([], 0).lastMs).toBe(0);
  });
});

const KYOTO = { lat: 35.0116, lng: 135.7681 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };
const setup: RoomSetup = {
  title: 'Test',
  country: 'Japan',
  games: [{ type: 'geo', settings: { guessMs: 30_000 }, items: [{ image: 'a'.repeat(22), label: 'Kyoto', ...KYOTO }] }],
};

/**
 * Each guest pins part of the way from Kyoto to Tokyo, so further along scores less and the
 * same distance ties. Null places no pin.
 */
function finalWith(distances: (number | null)[]) {
  const room = new Room('room', setup, 0);
  const ids = distances.map((_, index) => {
    const outcome = room.join(`hash-${index}`, `Guest ${index + 1}`, 1);
    if (outcome.kind !== 'joined') throw new Error('expected to join');
    room.connect(outcome.playerId, 1);
    return outcome.playerId;
  });
  room.next(room.screenId, 2);
  room.next(room.screenId, 3);
  distances.forEach((along, index) => {
    if (along === null) return;
    const lat = KYOTO.lat + (TOKYO.lat - KYOTO.lat) * along;
    const lng = KYOTO.lng + (TOKYO.lng - KYOTO.lng) * along;
    const result = room.submitPin(ids[index]!, room.screenId, 1, lat, lng, 10);
    if (!result.ok) throw new Error(`pin refused: ${result.code}`);
  });
  let now = 100;
  while (room.hostView().screen.kind !== 'final') {
    now += 100_000;
    if (room.hasRunningTimer) room.tick(now);
    else room.next(room.screenId, now);
  }
  const host = () => room.hostView().screen as HostFinal;
  const guest = (index: number) => room.guestView(ids[index]!)!.screen as GuestFinal;
  return { room, ids, now, host, guest };
}

describe('the final podium', () => {
  it('puts the top three on the podium and the next seven below, with the rest on their phones', () => {
    const { host } = finalWith(Array.from({ length: 14 }, (_, index) => index * 0.05));
    const screen = host();
    expect(screen.podium.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(screen.rows.map((row) => row.rank)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(screen.playerCount).toBe(14);
  });

  it('keeps everyone tied for a medal on the podium', () => {
    const { host } = finalWith([0, 0, 0.1, 0.1, 0.1, 0.1, 0.3, 0.4]);
    const screen = host();
    expect(screen.podium.map((row) => row.rank)).toEqual([1, 1, 3, 3, 3, 3]);
    expect(screen.rows.map((row) => row.rank)).toEqual([7, 8]);
  });

  it("holds each phone until that guest's place lands on the TV", () => {
    const { host, guest, now } = finalWith([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, null]);
    const screen = host();
    expect(screen.startedAt).toBe(now);
    // Phones wait a touch longer than the TV, so a slightly wrong clock can't spoil anything.
    const lands = Array.from({ length: 12 }, (_, index) => guest(index).landsAt - now - PODIUM.phoneDelayMs);
    const plan = podiumPlan([1, 2, 3], 7);
    expect(lands.slice(0, 3)).toEqual([plan.medalTimes[1], plan.medalTimes[2], plan.medalTimes[3]]);
    expect(lands.slice(3, 10)).toEqual(plan.listTimes);
    // Not on the TV at all, so they see their place as the list starts.
    expect(lands.slice(10)).toEqual([PODIUM.listAtMs, PODIUM.listAtMs]);
    expect(screen.endsAt - now).toBe(plan.lastMs);
    expect(guest(0)).toMatchObject({ rank: 1, playerCount: 12 });
  });

  it('lands guests tied for 1st together, with no beat for 2nd', () => {
    const { guest, host, now } = finalWith([0, 0, 0.3]);
    expect(host().podium.map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(guest(0).landsAt).toBe(guest(1).landsAt);
    expect(guest(0).landsAt - guest(2).landsAt).toBe(PODIUM.beforeWinnerMs);
    expect(host().endsAt - now).toBe(podiumPlan([1, 3], 0).lastMs);
  });

  it('shows everything at once when the presenter presses Space, then stays put', () => {
    const { room, guest, host, now } = finalWith([0, 0.2, 0.4, 0.6]);
    expect(room.next(room.screenId, now + 1000)).toEqual({ ok: true });
    expect(host().endsAt).toBe(now + 1000);
    for (let index = 0; index < 4; index += 1) expect(guest(index).landsAt).toBeLessThanOrEqual(now + 1000 + PODIUM.phoneDelayMs);
    expect(host().shown).toBe(true);
    expect(room.next(room.screenId, now + 2000)).toEqual({ ok: false, code: 'at_end' });
    expect(room.hostView().canAdvance).toBe(false);
  });

  it('works with one guest, and with nobody left', () => {
    const one = finalWith([0.2]);
    expect(one.host().podium).toHaveLength(1);
    expect(one.guest(0).landsAt - one.now).toBe(PODIUM.listAtMs + PODIUM.phoneDelayMs);
    expect(one.host().shown).toBe(false);

    const gone = finalWith([0.2, 0.4]);
    gone.room.remove(gone.ids[0]!, gone.now + 1);
    gone.room.remove(gone.ids[1]!, gone.now + 2);
    expect(gone.host()).toMatchObject({ podium: [], rows: [], playerCount: 0 });
  });

  it('comes back from a restart already finished, so the podium never replays', () => {
    const { room } = finalWith([0, 0.2, 0.4]);
    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())), 5_000_000)!;
    const screen = restored.hostView().screen as HostFinal;
    expect(screen.endsAt).toBe(5_000_000);
    expect(screen.shown).toBe(true);
    expect(screen.podium).toHaveLength(3);
    const id = screen.podium[0]!.id;
    expect((restored.guestView(id)!.screen as GuestFinal).landsAt).toBe(5_000_000 + PODIUM.phoneDelayMs);
  });
});

describe('when the TV plays its sounds', () => {
  const view = (screen: HostScreen): HostView => ({
    role: 'host',
    version: 1,
    roomId: 'r',
    joinCode: null,
    title: 'T',
    accent: null,
    screen,
    screenId: 4,
    canAdvance: false,
    joinLocked: true,
    capacity: 50,
    mapArea: null,
    players: [],
    rejoinRequests: [],
  });
  const round: RoundInfo = { game: 'define', gameNumber: 1, number: 1, count: 1, prompt: 'komorebi', image: null };

  it('ticks the last five seconds and sounds time up, but not while paused', async () => {
    const { plannedCues } = await import('../../client/src/host/useSoundCues.js');
    const timer = { endsAt: 60_000, totalMs: 60_000, pausedRemainingMs: null };
    const cues = plannedCues(view({ kind: 'write', round, timer, doneIds: [] }), 1000);
    expect(cues.map((cue) => [cue.cue, cue.at])).toEqual([
      ['tick', 54_000],
      ['tick', 55_000],
      ['tick', 56_000],
      ['tick', 57_000],
      ['tick', 58_000],
      ['timeUp', 59_000],
    ]);
    const paused = { ...timer, pausedRemainingMs: 20_000 };
    expect(plannedCues(view({ kind: 'write', round, timer: paused, doneIds: [] }), 0)).toEqual([]);
  });

  it('rings once as the real answer lands, and sooner after a skip', async () => {
    const { plannedCues } = await import('../../client/src/host/useSoundCues.js');
    const rows = [
      { id: 'a', text: 'A', real: false, top: false, author: 'Sam', votes: 0, masked: false },
      { id: 'b', text: 'B', real: true, top: false, author: null, votes: 2, masked: false },
    ];
    const screen: HostScreen = { kind: 'reveal', round, rows, startedAt: 10_000, endsAt: 20_000 };
    const [ring] = plannedCues(view(screen), 0);
    expect(ring).toMatchObject({ cue: 'real' });
    expect(ring!.at).toBeGreaterThan(10_000);
    expect(plannedCues(view({ ...screen, endsAt: 10_500 }), 0)[0]!.at).toBe(10_500);
  });

  it('hits each podium place as it lands, with the fanfare for 1st', async () => {
    const { plannedCues } = await import('../../client/src/host/useSoundCues.js');
    const row = (id: string, rank: number) => ({ id, rank, name: id, score: 100 - rank, previous: 0 });
    const plan = podiumPlan([1, 2, 3], 2);
    const screen: HostScreen = {
      kind: 'final',
      podium: [row('a', 1), row('b', 2), row('c', 3)],
      rows: [row('d', 4), row('e', 5)],
      playerCount: 5,
      startedAt: 0,
      endsAt: plan.lastMs,
      shown: false,
    };
    expect(plannedCues(view(screen), 0).map((cue) => [cue.cue, cue.at])).toEqual([
      ['listIn', PODIUM.listAtMs],
      ['place3', plan.medalTimes[3]],
      ['place2', plan.medalTimes[2]],
      ['place1', plan.medalTimes[1]],
    ]);
  });
});
