import { describe, expect, it } from 'vitest';
import { REJOIN_REQUEST_TTL_MS } from '../../shared/constants.js';
import { steadyNow } from '../../server/session/manager.js';
import { Room, type RoomSetup } from '../../server/session/room.js';

// With no words, a game is just its title card: lobby, title, final.
const games: RoomSetup['games'] = [{ type: 'define', items: [] }];

function makeRoom(options: { capacity?: number; blocklist?: string[] } = {}): Room {
  return new Room('room', { title: 'Test', games, ...options }, 0);
}

function joinOnline(room: Room, hash: string, name: string): string {
  const outcome = room.join(hash, name, 1);
  if (outcome.kind !== 'joined') throw new Error(`expected to join, got ${JSON.stringify(outcome)}`);
  room.connect(outcome.playerId, 1);
  return outcome.playerId;
}

describe('joining', () => {
  it('returns the same player when the same token sends again', () => {
    const room = makeRoom();
    const first = room.join('hash-a', 'Alex', 1);
    const second = room.join('hash-a', 'Someone else', 2);
    expect(second).toEqual(first);
    expect(room.playerCount).toBe(1);
  });

  it('stops at capacity, then frees a slot on removal', () => {
    const room = makeRoom({ capacity: 2 });
    const first = joinOnline(room, 'a', 'One');
    joinOnline(room, 'b', 'Two');
    expect(room.join('c', 'Three', 1)).toEqual({ kind: 'refused', code: 'room_full' });
    expect(room.joinState).toBe('full');
    room.remove(first, 2);
    expect(room.join('c', 'Three', 3).kind).toBe('joined');
  });

  it('refuses a name in use by an online player, including look-alikes', () => {
    const room = makeRoom();
    joinOnline(room, 'a', 'Alex');
    for (const name of ['Alex', 'alex', 'ＡＬＥＸ', 'A-lex', 'Аlex']) {
      expect(room.join('b', name, 2)).toEqual({ kind: 'refused', code: 'name_taken' });
    }
  });

  it('refuses empty, overlong and blocked names', () => {
    const room = makeRoom({ blocklist: ['jerk'] });
    expect(room.join('a', '​ ', 1)).toEqual({ kind: 'refused', code: 'name_empty' });
    expect(room.join('a', 'x'.repeat(17), 1)).toEqual({ kind: 'refused', code: 'name_too_long' });
    expect(room.join('a', 'Big Jerk', 1)).toEqual({ kind: 'refused', code: 'name_blocked' });
    expect(room.playerCount).toBe(0);
  });

  it('closes joining when the first game starts, and can reopen', () => {
    const room = makeRoom();
    joinOnline(room, 'first', 'First');
    room.next(0, 1);
    expect(room.joinState).toBe('locked');
    expect(room.join('a', 'Late', 2)).toEqual({ kind: 'refused', code: 'join_locked' });
    room.setJoinLocked(false, 3);
    expect(room.join('a', 'Late', 4).kind).toBe('joined');
  });

  it('still lets a joined guest return when locked or full', () => {
    const room = makeRoom({ capacity: 1 });
    joinOnline(room, 'a', 'Alex');
    room.setJoinLocked(true, 2);
    expect(room.lookupToken('a').kind).toBe('player');
    expect(room.join('a', 'Alex', 3).kind).toBe('joined');
  });
});

describe('screens', () => {
  it('moves one screen for a double press', () => {
    const room = makeRoom();
    joinOnline(room, 'a', 'Alex');
    expect(room.next(0, 1)).toEqual({ ok: true });
    expect(room.next(0, 2)).toEqual({ ok: false, code: 'stale_screen' });
    expect(room.screenId).toBe(1);
  });

  it('stops at the last screen, once the podium is up', () => {
    const room = makeRoom();
    joinOnline(room, 'a', 'Alex');
    room.next(0, 1);
    room.next(1, 2);
    // While the podium is still landing, a press shows it all.
    expect(room.next(2, 3)).toEqual({ ok: true });
    expect(room.next(2, 4)).toEqual({ ok: false, code: 'at_end' });
    expect(room.next(2, 60_000)).toEqual({ ok: false, code: 'at_end' });
  });

  it("won't leave an empty lobby, since a stray press has no way back", () => {
    const room = makeRoom();
    expect(room.hostView().canAdvance).toBe(false);
    expect(room.next(0, 1)).toEqual({ ok: false, code: 'no_players' });
    expect(room.screenId).toBe(0);
    expect(room.joinState).toBe('open');
    joinOnline(room, 'a', 'Alex');
    expect(room.hostView().canAdvance).toBe(true);
    expect(room.next(0, 3)).toEqual({ ok: true });
  });
});

describe('skipping the timer', () => {
  const WORD_GAME: RoomSetup = {
    title: 'Test',
    games: [{ type: 'define', items: [{ word: 'komorebi', definition: 'Sunlight through leaves' }] }],
  };

  function writing(): { room: Room; alex: string; sam: string } {
    const room = new Room('room', WORD_GAME, 0);
    const alex = joinOnline(room, 'a', 'Alex');
    const sam = joinOnline(room, 'b', 'Sam');
    room.next(0, 1);
    room.next(1, 2);
    return { room, alex, sam };
  }

  it('calls time and gives phones a moment to send what they have', () => {
    const { room, alex } = writing();
    expect(room.skipTimer(2, 100)).toEqual({ ok: true });
    expect(room.screenId).toBe(2);
    // Sent during the grace period, so it counts.
    expect(room.submitAnswer(alex, 2, 1, 'A quiet walk at dawn', 600)).toEqual({ ok: true });
    expect(room.tick(1000)).toBe('none');
    expect(room.tick(1600)).toBe('stage');
    expect(room.screenId).toBe(3);
  });

  it("tells phones time was called, so they send without trusting their own clock", () => {
    const { room, alex } = writing();
    const timerOf = () => (room.guestView(alex)!.screen as { timer: { cutShort?: boolean } }).timer;
    expect(timerOf().cutShort).toBe(false);
    room.skipTimer(2, 100);
    expect(timerOf().cutShort).toBe(true);
    // Adding time reopens the stage, so phones go back to the clock.
    room.addTime(2, 200);
    expect(timerOf().cutShort).toBe(false);
  });

  it('moves on at once when pressed again', () => {
    const { room, alex } = writing();
    room.submitAnswer(alex, 2, 1, 'A quiet walk at dawn', 50);
    room.skipTimer(2, 100);
    room.skipTimer(2, 200);
    expect(room.screenId).toBe(3);
  });

  it('moves on at once when everyone is already done', () => {
    const { room, alex, sam } = writing();
    room.submitAnswer(alex, 2, 1, 'A quiet walk at dawn', 50);
    room.submitAnswer(sam, 2, 1, 'Grilled eel in winter', 60);
    room.skipTimer(2, 100);
    expect(room.screenId).toBe(3);
  });

  it('moves on at once when nobody is connected', () => {
    const room = new Room('room', WORD_GAME, 0);
    const alex = joinOnline(room, 'a', 'Alex');
    room.next(0, 1);
    room.next(1, 2);
    room.disconnect(alex, 3);
    room.skipTimer(2, 60_000);
    expect(room.hostView().screen.kind).toBe('reveal'); // No answers, so nothing to show or vote on.
  });

  it('gives the original success to a repeat arriving after the deadline', () => {
    const { room, alex } = writing();
    expect(room.submitAnswer(alex, 2, 3, 'A quiet walk at dawn', 50)).toEqual({ ok: true });
    expect(room.submitAnswer(alex, 2, 3, 'A quiet walk at dawn', 70_000)).toEqual({ ok: true });
  });

  it('calls time on a paused timer too, rather than staying frozen', () => {
    const { room } = writing();
    room.setPaused(true, 50);
    room.skipTimer(2, 100);
    expect(room.tick(1700)).toBe('stage');
  });
});

describe('removing', () => {
  it('blocks the token and frees the name', () => {
    const room = makeRoom();
    const id = joinOnline(room, 'a', 'Alex');
    room.remove(id, 2);
    expect(room.lookupToken('a')).toEqual({ kind: 'revoked', reason: 'removed' });
    expect(room.join('a', 'Alex', 3)).toEqual({ kind: 'refused', code: 'removed' });
    expect(room.join('b', 'Alex', 3).kind).toBe('joined');
  });
});

describe('new-phone rejoin', () => {
  it('asks only when the named player is offline', () => {
    const room = makeRoom();
    const id = joinOnline(room, 'old', 'Alex');
    expect(room.join('new', 'Alex', 2).kind).toBe('refused');
    room.disconnect(id, 3);
    expect(room.join('new', 'alex', 4)).toEqual({ kind: 'pending', created: true });
    expect(room.lookupToken('new')).toEqual({ kind: 'pending' });
  });

  it('moves the player to the new phone and cancels the old token on approval', () => {
    const room = makeRoom();
    const id = joinOnline(room, 'old', 'Alex');
    room.disconnect(id, 2);
    room.join('new', 'Alex', 3);
    const prompt = room.hostView().rejoinRequests[0]!;
    expect(prompt.name).toBe('Alex');
    room.answerRejoin(prompt.id, true, 4);
    expect(room.lookupToken('new')).toEqual({ kind: 'player', playerId: id });
    expect(room.lookupToken('old')).toEqual({ kind: 'revoked', reason: 'superseded' });
    expect(room.playerCount).toBe(1);
  });

  it('leaves everything alone when declined', () => {
    const room = makeRoom();
    const id = joinOnline(room, 'old', 'Alex');
    room.disconnect(id, 2);
    room.join('new', 'Alex', 3);
    room.answerRejoin(room.hostView().rejoinRequests[0]!.id, false, 4);
    expect(room.lookupToken('old')).toEqual({ kind: 'player', playerId: id });
    expect(room.lookupToken('new')).toEqual({ kind: 'unknown' });
  });

  it('works when joining is locked, because it adds nobody', () => {
    const room = makeRoom({ capacity: 1 });
    const id = joinOnline(room, 'old', 'Alex');
    room.setJoinLocked(true, 2);
    room.disconnect(id, 3);
    expect(room.join('new', 'Alex', 4).kind).toBe('pending');
  });

  it('allows one request per player, and a few in total', () => {
    const room = makeRoom();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => joinOnline(room, `o${name}`, name));
    ids.forEach((id) => room.disconnect(id, 2));
    expect(room.join('x1', 'A', 3).kind).toBe('pending');
    expect(room.join('x2', 'A', 3)).toEqual({ kind: 'refused', code: 'rejoin_busy' });
    ['B', 'C', 'D', 'E'].forEach((name) => room.join(`x${name}`, name, 3));
    expect(room.join('xF', 'F', 3)).toEqual({ kind: 'refused', code: 'rejoin_busy' });
  });

  it('cancels the request when the real owner comes back', () => {
    const room = makeRoom();
    const id = joinOnline(room, 'old', 'Alex');
    room.disconnect(id, 2);
    room.join('new', 'Alex', 3);
    expect(room.connect(id, 4)).toEqual([{ tokenHash: 'new', result: 'cancelled' }]);
    expect(room.hostView().rejoinRequests).toEqual([]);
  });

  it('expires unanswered requests', () => {
    const room = makeRoom();
    const id = joinOnline(room, 'old', 'Alex');
    room.disconnect(id, 2);
    room.join('new', 'Alex', 3);
    expect(room.expireRequests(3 + REJOIN_REQUEST_TTL_MS - 1)).toEqual([]);
    expect(room.expireRequests(3 + REJOIN_REQUEST_TTL_MS)).toEqual([{ tokenHash: 'new', result: 'expired' }]);
  });
});

describe('what each client can see', () => {
  it('never puts tokens or hashes in a view', () => {
    const room = makeRoom();
    const id = joinOnline(room, 'secret-hash', 'Alex');
    expect(JSON.stringify(room.hostView())).not.toContain('secret-hash');
    expect(JSON.stringify(room.guestView(id))).not.toContain('secret-hash');
  });

  it("gives a guest a head count, not other guests' names or ids", () => {
    const room = makeRoom();
    const id = joinOnline(room, 'a', 'Alex');
    const other = joinOnline(room, 'b', 'Hidden');
    const view = JSON.stringify(room.guestView(id));
    expect(view).not.toContain('Hidden');
    expect(view).not.toContain(other);
    expect(room.guestView(id)?.playerCount).toBe(2);
  });
});

describe('snapshots', () => {
  it('restores the game with everyone offline', () => {
    const room = makeRoom({ capacity: 7, blocklist: ['jerk'] });
    const id = joinOnline(room, 'a', 'Alex');
    room.next(0, 2);
    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())))!;
    expect(restored.screenId).toBe(1);
    expect(restored.joinLocked).toBe(true);
    expect(restored.capacity).toBe(7);
    expect(restored.lookupToken('a')).toEqual({ kind: 'player', playerId: id });
    expect(restored.hostView().players).toEqual([{ id, name: 'Alex', online: false, leftPage: false }]);
    expect(restored.join('b', 'Alex', 3).kind).toBe('pending');
  });

  it('keeps removals in force', () => {
    const room = makeRoom();
    room.remove(joinOnline(room, 'a', 'Alex'), 2);
    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())))!;
    expect(restored.lookupToken('a')).toEqual({ kind: 'revoked', reason: 'removed' });
  });

  it.each([[null], [{}], [{ schema: 3 }], [{ schema: 2 }], [{ schema: 1 }], ['text']])('refuses a damaged snapshot: %j', (value) => {
    expect(Room.fromSnapshot(value)).toBeNull();
  });

  it('refuses a screen position past the end', () => {
    const snapshot = makeRoom().toSnapshot();
    expect(Room.fromSnapshot({ ...snapshot, screenIndex: 99 })).toBeNull();
  });
});

describe('game time', () => {
  it('stays close to real time and never moves backward, even if the system clock does', () => {
    const first = steadyNow();
    expect(Math.abs(first - Date.now())).toBeLessThan(5000);
    const realDateNow = Date.now;
    Date.now = () => realDateNow() - 60_000;
    try {
      expect(steadyNow()).toBeGreaterThanOrEqual(first);
    } finally {
      Date.now = realDateNow;
    }
  });
});

describe('Caption this', () => {
  const PHOTOS = ['photo-one', 'photo-two'];
  const captionGames: RoomSetup['games'] = [{ type: 'caption', items: PHOTOS.map((image) => ({ image })) }];

  function roomWithGuests(names: string[], setup: Partial<RoomSetup> = {}) {
    const room = new Room('room', { title: 'Test', games: captionGames, ...setup }, 0);
    return { room, ids: names.map((name) => joinOnline(room, `hash-${name}`, name)) };
  }

  /** Lobby to title, then title to the first round's writing stage. */
  function toWriting(room: Room, now = 10) {
    room.next(room.screenId, now);
    room.next(room.screenId, now);
  }

  /** From writing, through the captions being shown, to the vote. */
  function toVoting(room: Room, now: number) {
    for (let press = 0; press < 3 && room.hostView().screen.kind !== 'vote'; press += 1) {
      room.skipTimer(room.screenId, now);
    }
    expect(room.hostView().screen.kind).toBe('vote');
  }

  /** Three guests write, and the room arrives at the first caption being shown. */
  function toShowing(setup: Partial<RoomSetup> = {}) {
    const { room, ids } = roomWithGuests(['Alex', 'Sam', 'Priya'], setup);
    toWriting(room);
    room.submitAnswer(ids[0]!, room.screenId, 1, 'A cat judging the entire platform', 11);
    room.submitAnswer(ids[1]!, room.screenId, 1, 'Rush hour, as seen by the pigeons', 11);
    room.submitAnswer(ids[2]!, room.screenId, 1, 'Local man discovers the concept of stairs', 11);
    room.skipTimer(room.screenId, 12);
    return { room, ids };
  }

  function shown(room: Room) {
    const screen = room.hostView().screen;
    if (screen.kind !== 'show') throw new Error(`expected a caption, got ${screen.kind}`);
    return screen;
  }

  it('shows each caption by itself, then opens them all for the vote', () => {
    const { room, ids } = toShowing();
    const first = shown(room);
    expect(first).toMatchObject({ number: 1, count: 3 });
    const shownTexts = [first.entry.text];

    const elapsed = first.timer.endsAt;
    expect(room.tick(elapsed - 1)).toBe('none');
    expect(shown(room).number).toBe(1);
    expect(room.tick(elapsed)).toBe('changed');
    expect(shown(room).number).toBe(2);
    shownTexts.push(shown(room).entry.text);

    expect(room.tick(shown(room).timer.endsAt)).toBe('changed');
    expect(shown(room).number).toBe(3);
    shownTexts.push(shown(room).entry.text);
    expect(new Set(shownTexts).size).toBe(3);

    expect(room.tick(shown(room).timer.endsAt)).toBe('stage');
    const vote = room.hostView().screen;
    if (vote.kind !== 'vote') throw new Error(`expected voting, got ${vote.kind}`);
    expect(vote.entries.map((entry) => entry.text).sort()).toEqual([...shownTexts].sort());
    expect(vote.timer.totalMs).toBe(45_000);
    expect(room.guestView(ids[0]!)!.screen.kind).toBe('vote');
  });

  it('keeps the caption and its author off every phone, and takes no votes yet', () => {
    const { room, ids } = toShowing();
    const phone = room.guestView(ids[2]!)!;
    expect(phone.screen).toMatchObject({ kind: 'show', number: 1, count: 3 });
    expect(JSON.stringify(phone)).not.toMatch(/cat judging|pigeons|stairs/);
    const { entry } = shown(room);
    expect(JSON.stringify(room.hostView().screen)).not.toMatch(/Alex|Sam|Priya/);
    expect(room.submitVote(ids[2]!, room.screenId, 1, entry.id, 13)).toEqual({ ok: false, code: 'too_late' });
  });

  it('lets the presenter move on, hold on a good one, or skip to the vote', () => {
    const { room } = toShowing();
    expect(room.hostView().canAdvance).toBe(true);
    expect(room.next(room.screenId, 13)).toEqual({ ok: true });
    expect(shown(room).number).toBe(2);

    room.setPaused(true, 14);
    expect(room.tick(1_000_000)).toBe('none');
    expect(shown(room).number).toBe(2);
    room.setPaused(false, 1_000_000);
    expect(shown(room).timer.endsAt).toBeGreaterThan(1_000_000);

    expect(room.skipTimer(room.screenId, 1_000_001)).toEqual({ ok: true });
    expect(room.hostView().screen.kind).toBe('vote');
  });

  it('moves straight on from a hidden caption, or a removed player\'s, and renumbers', () => {
    const { room, ids } = toShowing();
    const first = shown(room).entry;
    expect(room.hideEntry(first.id, 13)).toEqual({ ok: true });
    expect(shown(room)).toMatchObject({ number: 1, count: 2 });
    expect(shown(room).entry.id).not.toBe(first.id);

    const texts: Record<string, number> = {
      'A cat judging the entire platform': 0,
      'Rush hour, as seen by the pigeons': 1,
      'Local man discovers the concept of stairs': 2,
    };
    room.remove(ids[texts[shown(room).entry.text]!]!, 14);
    expect(shown(room)).toMatchObject({ number: 1, count: 1 });
    room.next(room.screenId, 15);
    // With one caption left there's nothing to vote between, so it goes on to the reveal.
    expect(room.hostView().screen.kind).toBe('reveal');
  });

  it('skips the showing when there is nothing to compare', () => {
    const { room, ids } = roomWithGuests(['Alex', 'Sam']);
    toWriting(room);
    room.submitAnswer(ids[0]!, room.screenId, 1, 'The only caption', 11);
    room.skipTimer(room.screenId, 12);
    room.skipTimer(room.screenId, 12);
    expect(room.hostView().screen.kind).toBe('reveal');
  });

  it('uses the time set in the deck', () => {
    const { room } = toShowing({ games: [{ type: 'caption', settings: { showMs: 3000 }, items: [{ image: 'photo' }] }] });
    expect(shown(room).timer.totalMs).toBe(3000);
  });

  it('starts the showing again after a restart, with the same captions', () => {
    const { room } = toShowing();
    room.next(room.screenId, 13);
    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())), 20)!;
    expect(shown(restored)).toMatchObject({ number: 1, count: 3 });
    expect(shown(restored).timer.endsAt).toBeGreaterThan(20);
  });

  it('gives each photo a round, with no real answer and the longer default writing time', () => {
    const { room, ids } = roomWithGuests(['Alex', 'Sam']);
    toWriting(room);
    const host = room.hostView().screen;
    if (host.kind !== 'write') throw new Error(`expected writing, got ${host.kind}`);
    expect(host.round).toMatchObject({ game: 'caption', number: 1, count: 2, prompt: '', image: 'photo-one' });
    expect(host.timer.totalMs).toBe(75_000);
    room.submitAnswer(ids[0]!, room.screenId, 1, 'A cat judging the entire platform', 11);
    room.submitAnswer(ids[1]!, room.screenId, 1, 'Rush hour, as seen by the pigeons', 11);
    toVoting(room, 12);
    const vote = room.hostView().screen;
    if (vote.kind !== 'vote') throw new Error(`expected voting, got ${vote.kind}`);
    expect(vote.entries).toHaveLength(2);
    expect(vote.timer.totalMs).toBe(45_000);
  });

  it('shows no photo until its own round has started', () => {
    const { room, ids } = roomWithGuests(['Alex']);
    const views = () => JSON.stringify([room.hostView(), room.guestView(ids[0]!)]);
    expect(views()).not.toContain('photo-');
    room.next(room.screenId, 10);
    expect(views()).not.toContain('photo-');
    room.next(room.screenId, 10);
    expect(views()).toContain('photo-one');
    expect(views()).not.toContain('photo-two');
  });

  it('lets a joke share its opening with another, but not be a copy', () => {
    const { room, ids } = roomWithGuests(['Alex', 'Sam', 'Priya']);
    toWriting(room);
    expect(room.submitAnswer(ids[0]!, room.screenId, 1, 'Me when I see the vending machine', 11).ok).toBe(true);
    expect(room.submitAnswer(ids[1]!, room.screenId, 1, 'Me when I see the toilet', 11).ok).toBe(true);
    expect(room.submitAnswer(ids[2]!, room.screenId, 1, 'me when i see THE vending machines!', 11)).toEqual({
      ok: false,
      code: 'too_similar',
    });
  });

  it('adds the top bonus across rounds and reports it to the phone', () => {
    const { room, ids } = roomWithGuests(['Alex', 'Sam', 'Priya']);
    const [alex, sam, priya] = ids as [string, string, string];
    toWriting(room);
    room.submitAnswer(alex, room.screenId, 1, 'A cat judging the entire platform', 11);
    room.submitAnswer(sam, room.screenId, 1, 'Rush hour, as seen by the pigeons', 11);
    toVoting(room, 12);
    const ballot = (id: string) => {
      const view = room.guestView(id)!.screen;
      if (view.kind !== 'vote') throw new Error(`expected voting, got ${view.kind}`);
      return view.options;
    };
    const pick = (id: string, text: string) => ballot(id).find((option) => option.text === text)!.id;
    expect(ballot(alex).map((option) => option.text)).toEqual(['Rush hour, as seen by the pigeons']);
    room.submitVote(alex, room.screenId, 1, pick(alex, 'Rush hour, as seen by the pigeons'), 13);
    room.submitVote(priya, room.screenId, 1, pick(priya, 'Rush hour, as seen by the pigeons'), 13);
    room.submitVote(sam, room.screenId, 1, pick(sam, 'A cat judging the entire platform'), 13);
    room.skipTimer(room.screenId, 14);
    room.skipTimer(room.screenId, 14);

    const samView = room.guestView(sam)!.screen;
    const alexView = room.guestView(alex)!.screen;
    if (samView.kind !== 'reveal' || alexView.kind !== 'reveal') throw new Error('expected the reveal');
    expect(samView.result).toMatchObject({ votes: 2, top: true, points: 2 * 200 + 500, wrote: true });
    expect(alexView.result).toMatchObject({ votes: 1, top: false, points: 200 });
    expect(room.guestView(priya)!.screen).toMatchObject({ result: { wrote: false, top: false, points: 0 } });
    const host = room.hostView().screen;
    if (host.kind !== 'reveal') throw new Error('expected the reveal');
    expect(host.rows.at(-1)).toMatchObject({ author: 'Sam', top: true, real: false, votes: 2 });
  });

  it('finishes cleanly with no captions, or just one', () => {
    const { room, ids } = roomWithGuests(['Alex', 'Sam']);
    toWriting(room);
    room.skipTimer(room.screenId, 11);
    room.skipTimer(room.screenId, 11);
    let host = room.hostView().screen;
    expect(host).toMatchObject({ kind: 'reveal', rows: [] });
    room.next(room.screenId, 12);
    expect(room.hostView().screen.kind).toBe('write');

    room.submitAnswer(ids[0]!, room.screenId, 1, 'The only caption', 13);
    room.skipTimer(room.screenId, 14);
    room.skipTimer(room.screenId, 14);
    host = room.hostView().screen;
    if (host.kind !== 'reveal') throw new Error(`expected the reveal, got ${host.kind}`);
    expect(host.rows).toHaveLength(1);
    expect(host.rows[0]).toMatchObject({ top: false, votes: 0 });
    expect(room.guestView(ids[0]!)!.screen).toMatchObject({ result: { wrote: true, points: 0, top: false } });
    room.next(room.screenId, 15);
    expect(room.hostView().screen).toMatchObject({ kind: 'standings', game: 'caption' });
  });

  it('comes back from a restart mid-vote with the same photo and votes', () => {
    const { room, ids } = roomWithGuests(['Alex', 'Sam', 'Priya']);
    const [alex, sam, priya] = ids as [string, string, string];
    toWriting(room);
    room.submitAnswer(alex, room.screenId, 1, 'A cat judging the entire platform', 11);
    room.submitAnswer(sam, room.screenId, 1, 'Rush hour, as seen by the pigeons', 11);
    toVoting(room, 12);
    const view = room.guestView(priya)!.screen;
    if (view.kind !== 'vote') throw new Error('expected voting');
    room.submitVote(priya, room.screenId, 1, view.options[0]!.id, 13);

    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())), 20)!;
    expect(restored).not.toBeNull();
    expect(restored.guestView(priya)!.screen).toMatchObject({
      kind: 'vote',
      vote: view.options[0]!.id,
      round: { image: 'photo-one' },
    });
  });
});

describe('Define it, one answer at a time', () => {
  const REAL_ANSWER = 'Sunlight filtering through the leaves of trees';
  const setup: RoomSetup = {
    title: 'Test',
    games: [{ type: 'define', items: [{ word: 'komorebi', definition: REAL_ANSWER }] }],
  };

  function showing() {
    const room = new Room('room', setup, 0);
    const alex = joinOnline(room, 'a', 'Alex');
    const sam = joinOnline(room, 'b', 'Sam');
    room.next(0, 1);
    room.next(1, 2);
    room.submitAnswer(alex, 2, 1, 'A quiet walk at dawn', 3);
    room.submitAnswer(sam, 2, 1, 'Grilled eel in winter', 3);
    room.skipTimer(2, 4);
    return { room, alex, sam };
  }

  function current(room: Room) {
    const screen = room.hostView().screen;
    if (screen.kind !== 'show') throw new Error(`expected an answer, got ${screen.kind}`);
    return screen;
  }

  it('shows every answer once with the real one among them, unmarked, then opens the vote', () => {
    const { room } = showing();
    expect(current(room)).toMatchObject({ number: 1, count: 3, round: { game: 'define', prompt: 'komorebi' } });
    const seen: string[] = [];
    for (let shown = 0; shown < 3; shown += 1) {
      const screen = current(room);
      seen.push(screen.entry.text);
      expect(Object.keys(screen.entry).sort()).toEqual(['id', 'text']);
      room.tick(screen.timer.endsAt);
    }
    expect(seen.sort()).toEqual(['A quiet walk at dawn', 'Grilled eel in winter', REAL_ANSWER].sort());
    expect(room.hostView().screen.kind).toBe('vote');
  });

  it('never sends the real answer to a phone while they are being shown', () => {
    const { room, alex } = showing();
    const phone = JSON.stringify(room.guestView(alex));
    expect(phone).not.toContain(REAL_ANSWER);
    expect(phone).not.toContain('Grilled eel');
    expect(room.guestView(alex)!.screen).toMatchObject({ kind: 'show', number: 1, count: 3 });
  });

  it('keeps the real answer in when asked to hide it', () => {
    const { room } = showing();
    while (current(room).entry.text !== REAL_ANSWER) room.next(room.screenId, 5);
    const { entry, number } = current(room);
    expect(room.hideEntry(entry.id, 6)).toEqual({ ok: false, code: 'cannot_hide' });
    expect(current(room)).toMatchObject({ number, entry });
  });

  it('skips the showing when nobody wrote anything', () => {
    const room = new Room('room', setup, 0);
    joinOnline(room, 'a', 'Alex');
    room.next(0, 1);
    room.next(1, 2);
    room.skipTimer(2, 3);
    room.skipTimer(2, 3);
    expect(room.hostView().screen.kind).toBe('reveal');
  });
});
