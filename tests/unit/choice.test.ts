import { describe, expect, it } from 'vitest';
import { ChoiceRound } from '../../server/games/choice.js';
import { deckToSetup } from '../../server/decks.js';
import { Room, type RoomSetup } from '../../server/session/room.js';
import { deckProblems, emptyChoice, sampleDeck, type ChoiceGame, type DeckContent } from '../../shared/deck.js';
import type { GuestScreen, HostScreen } from '../../shared/protocol.js';

type HostPick = Extract<HostScreen, { kind: 'pick' }>;
type HostReveal = Extract<HostScreen, { kind: 'pickReveal' }>;
type GuestPick = Extract<GuestScreen, { kind: 'pick' }>;
type GuestReveal = Extract<GuestScreen, { kind: 'pickReveal' }>;

const OPTIONS = ['Bow', 'Dance', 'Sing', 'Roll over'];

function choiceRound(): ChoiceRound {
  return new ChoiceRound({ image: 'photo', question: 'What do they do?', options: OPTIONS, answer: 0, answerMs: 30_000, points: 1000 });
}

describe('a Pick one round', () => {
  it('keeps one current choice per guest, and a new one replaces it', () => {
    const round = choiceRound();
    round.pick('a', 2);
    round.pick('a', 0);
    expect(round.pickOf('a')).toBe(0);
    expect(round.pickedIds()).toEqual(['a']);
  });

  it('refuses an answer that is not on the list, and leaves the old one', () => {
    const round = choiceRound();
    round.pick('a', 1);
    expect(round.pick('a', 4)).toEqual({ ok: false, code: 'not_found' });
    expect(round.pick('a', -1)).toEqual({ ok: false, code: 'not_found' });
    expect(round.pickOf('a')).toBe(1);
  });

  it('ignores repeats and older messages', () => {
    const round = choiceRound();
    const pick = (seq: number, option: number) => round.act('a', seq, () => round.pick('a', option));
    expect(pick(2, 1)).toEqual({ ok: true });
    expect(pick(2, 3)).toEqual({ ok: true });
    expect(round.pickOf('a')).toBe(1);
    expect(pick(1, 3)).toEqual({ ok: false, code: 'stale_action' });
    expect(round.lastSeq('a')).toBe(2);
  });

  it('scores the right answer only, and only once', () => {
    const round = choiceRound();
    round.pick('right', 0);
    round.pick('wrong', 3);
    const results = round.resolve();
    expect(results.get('right')).toEqual({ correct: true, points: 1000 });
    expect(results.get('wrong')).toEqual({ correct: false, points: 0 });
    round.pick('late', 0);
    expect(round.resolve().has('late')).toBe(false);
    expect(round.resultOf('nobody')).toBeNull();
  });

  it('counts each answer, leaving out guests who are gone', () => {
    const round = choiceRound();
    round.pick('a', 0);
    round.pick('b', 0);
    round.pick('c', 2);
    expect(round.revealRows((id) => id !== 'b').map((row) => [row.text, row.count, row.correct])).toEqual([
      ['Bow', 1, true],
      ['Dance', 0, false],
      ['Sing', 1, false],
      ['Roll over', 0, false],
    ]);
  });
});

const setup: RoomSetup = {
  title: 'Test',
  games: [
    {
      type: 'choice',
      items: [
        { image: 'photo-1', question: 'What do they do?', options: OPTIONS, answer: 0 },
        { image: 'photo-2', question: '', options: ['1', '2', '3', '4'], answer: 3 },
      ],
    },
  ],
};

/** Joins everyone and moves on to the first photo's question. */
function started(names = ['Alex', 'Sam', 'Kai']) {
  const room = new Room('room', setup, 0);
  const ids = names.map((name, index) => {
    const outcome = room.join(`hash-${index}`, name, 1);
    if (outcome.kind !== 'joined') throw new Error('expected to join');
    room.connect(outcome.playerId, 1);
    return outcome.playerId;
  });
  room.next(0, 2);
  room.next(1, 3);
  return { room, ids };
}

function endPick(room: Room, now: number): void {
  room.skipTimer(room.screenId, now);
  room.skipTimer(room.screenId, now);
}

describe('Pick one in a room', () => {
  it('shows the photo, the question and the four answers, with nothing to say which is right', () => {
    const { room, ids } = started();
    const host = room.hostView().screen as HostPick;
    expect(host.kind).toBe('pick');
    expect(host.round).toMatchObject({ game: 'choice', prompt: 'What do they do?', image: 'photo-1', number: 1, count: 2 });
    expect(host.options).toEqual(OPTIONS);
    expect(host.timer.endsAt).toBe(30_003);
    const guest = room.guestView(ids[0]!)!.screen as GuestPick;
    expect(guest).toMatchObject({ kind: 'pick', options: OPTIONS, pick: null, lastSeq: 0 });
    for (const view of [room.hostView(), room.guestView(ids[0]!)]) {
      expect(JSON.stringify(view)).not.toMatch(/correct|answer/);
    }
  });

  it("never shows a guest anyone else's choice, and the TV only who's in", () => {
    const { room, ids } = started();
    expect(room.submitPick(ids[0]!, room.screenId, 1, 2, 10)).toEqual({ ok: true });
    expect((room.guestView(ids[0]!)!.screen as GuestPick).pick).toBe(2);
    expect((room.guestView(ids[1]!)!.screen as GuestPick).pick).toBeNull();
    expect((room.hostView().screen as HostPick).doneIds).toEqual([ids[0]]);
  });

  it('drops to the final seconds once everyone has chosen', () => {
    const { room, ids } = started();
    for (const id of ids) room.submitPick(id, room.screenId, 1, 1, 10);
    expect(room.tick(20)).toBe('changed');
    expect((room.hostView().screen as HostPick).timer.endsAt).toBe(5020);
  });

  it('refuses a late choice, or one for another screen', () => {
    const { room, ids } = started();
    const { screenId } = room;
    expect(room.submitPick(ids[0]!, screenId + 1, 1, 0, 10)).toEqual({ ok: false, code: 'too_late' });
    expect(room.submitPick(ids[0]!, screenId, 2, 0, 40_000)).toEqual({ ok: false, code: 'too_late' });
  });

  it('reveals the counts, the right answer and who got it, and scores once', () => {
    const { room, ids } = started();
    room.submitPick(ids[0]!, room.screenId, 1, 0, 10);
    room.submitPick(ids[1]!, room.screenId, 1, 2, 10);
    endPick(room, 11);
    const host = room.hostView().screen as HostReveal;
    expect(host.kind).toBe('pickReveal');
    expect(host.rows.map((row) => row.count)).toEqual([1, 0, 1, 0]);
    expect(host.rows.map((row) => row.correct)).toEqual([true, false, false, false]);
    expect(host.right).toEqual(['Alex']);
    expect(host.answered).toBe(2);

    const right = room.guestView(ids[0]!)!.screen as GuestReveal;
    expect(right.answer).toBe('Bow');
    expect(right.result).toEqual({ picked: true, correct: true, points: 1000, total: 1000, rank: 1 });
    expect((room.guestView(ids[1]!)!.screen as GuestReveal).result).toMatchObject({ picked: true, correct: false, points: 0 });
    expect((room.guestView(ids[2]!)!.screen as GuestReveal).result).toMatchObject({ picked: false, correct: false });
  });

  it('holds on the reveal for a first Space, then moves on', () => {
    const { room } = started();
    endPick(room, 10);
    const screen = room.screenId;
    room.next(screen, 20);
    expect(room.screenId).toBe(screen);
    expect((room.hostView().screen as HostReveal).endsAt).toBe(20);
    room.next(screen, 30);
    expect(room.screenId).toBe(screen + 1);
  });

  it('takes a removed guest out of the counts and the names', () => {
    const { room, ids } = started();
    room.submitPick(ids[0]!, room.screenId, 1, 0, 10);
    room.submitPick(ids[1]!, room.screenId, 1, 0, 10);
    room.remove(ids[0]!, 11);
    endPick(room, 12);
    const host = room.hostView().screen as HostReveal;
    expect(host.rows[0]!.count).toBe(1);
    expect(host.right).toEqual(['Sam']);
  });

  it('counts this game in the standings', () => {
    const { room, ids } = started(['Alex']);
    room.submitPick(ids[0]!, room.screenId, 1, 0, 10);
    endPick(room, 11);
    room.next(room.screenId, 20);
    room.next(room.screenId, 21);
    room.submitPick(ids[0]!, room.screenId, 1, 3, 22);
    endPick(room, 23);
    room.next(room.screenId, 30);
    room.next(room.screenId, 31);
    const screen = room.hostView().screen;
    if (screen.kind !== 'standings') throw new Error(`expected standings, got ${screen.kind}`);
    expect(screen.game).toBe('choice');
    expect(screen.rows[0]).toMatchObject({ score: 2000, previous: 0 });
  });

  it('shows the extra photos after the reveal', () => {
    const room = new Room(
      'room',
      { title: 'Test', games: [{ type: 'choice', items: [{ image: 'p', question: 'Q', options: OPTIONS, answer: 1, extras: ['x'] }] }] },
      0,
    );
    const outcome = room.join('hash', 'Alex', 1);
    if (outcome.kind !== 'joined') throw new Error('expected to join');
    room.next(0, 2);
    room.next(1, 3);
    endPick(room, 4);
    room.next(room.screenId, 5);
    room.next(room.screenId, 6);
    expect(room.hostView().screen).toMatchObject({ kind: 'gallery', images: ['x'] });
  });

  describe('after a restart', () => {
    const restore = (room: Room, now: number) => Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())), now)!;

    it('keeps choices, and restarts the timer', () => {
      const { room, ids } = started();
      room.submitPick(ids[0]!, room.screenId, 1, 2, 10);
      const restored = restore(room, 5000);
      const screen = restored.guestView(ids[0]!)!.screen as GuestPick;
      expect(screen.pick).toBe(2);
      expect(screen.lastSeq).toBe(1);
      expect(screen.timer.endsAt).toBe(35_000);
    });

    it('never scores a reveal twice', () => {
      const { room, ids } = started(['Alex']);
      room.submitPick(ids[0]!, room.screenId, 1, 0, 10);
      endPick(room, 11);
      const restored = restore(room, 5000);
      expect((restored.hostView().screen as HostReveal).endsAt).toBe(5000);
      expect((restored.guestView(ids[0]!)!.screen as GuestReveal).result.total).toBe(1000);
    });

    it('refuses a snapshot with the wrong number of photos', () => {
      const { room } = started();
      expect(Room.fromSnapshot({ ...room.toSnapshot(), choiceRounds: [] })).toBeNull();
    });

    it('still loads a game saved before Pick one existed', () => {
      const room = new Room('room', { title: 'Old', games: [{ type: 'define', items: [] }] }, 0);
      const { choiceRounds: _choiceRounds, ...old } = room.toSnapshot();
      expect(Room.fromSnapshot(old)).not.toBeNull();
    });
  });
});

function withChoice(items: ChoiceGame['items'], settings: ChoiceGame['settings'] = {}): DeckContent {
  return { ...sampleDeck(), games: [{ type: 'choice', settings, items }] };
}

const IMAGE = 'A'.repeat(22);

describe('Pick one in a deck', () => {
  it('is ready with four different answers, and the question is optional', () => {
    expect(deckProblems(withChoice([{ ...emptyChoice(IMAGE), options: OPTIONS }]))).toEqual([]);
  });

  it('asks for every answer, different from each other, and short enough', () => {
    const item = { ...emptyChoice(IMAGE), question: 'Q'.repeat(101), options: ['Kyoto', ' kyoto. ', '', 'x'.repeat(61)] };
    expect(deckProblems(withChoice([item]))).toEqual([
      'Pick one, photo 1: shorten the question to 100 characters.',
      'Pick one, photo 1: fill in answer C.',
      'Pick one, photo 1: shorten answer D to 60 characters.',
      'Pick one, photo 1: make the four answers different.',
    ]);
  });

  it('shuffles the answers for the game, keeping the right one right', () => {
    const orders = new Set<string>();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const setup = deckToSetup(
        withChoice([{ image: IMAGE, question: '  What   do they do? ', options: [' Bow ', 'Dance', 'Sing', 'Roll over'], answer: 0 }], {
          answerSeconds: 20,
          points: 500,
        }),
      );
      const game = setup.games[0]!;
      if (game.type !== 'choice') throw new Error('expected Pick one');
      expect(game.settings).toEqual({ answerMs: 20_000, points: 500 });
      const [item] = game.items;
      expect(item!.question).toBe('What do they do?');
      expect([...item!.options].sort()).toEqual(['Bow', 'Dance', 'Roll over', 'Sing']);
      expect(item!.options[item!.answer]).toBe('Bow');
      orders.add(item!.options.join());
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});
