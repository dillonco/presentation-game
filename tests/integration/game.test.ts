import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { GuestView, HostView } from '../../shared/protocol.js';
import type { RoomSetup } from '../../server/session/room.js';
import { PODIUM } from '../../shared/reveal.js';
import { command, hostHello, newToken, send, startHarness, type Harness } from './helpers.js';

const REAL = 'Sunlight filtering through the leaves of trees';
const WRITE_MS = 60_000;
const VOTE_MS = 45_000;
const GRACE_MS = 1500;

const DECK: RoomSetup = {
  title: 'Test deck',
  blocklist: ['jerk'],
  games: [
    {
      type: 'define',
      settings: { writeMs: WRITE_MS, voteMs: VOTE_MS },
      items: [
        { word: 'komorebi', definition: REAL },
        { word: 'tsundoku', definition: 'Buying books and letting them pile up unread' },
      ],
    },
  ],
};

interface Guest {
  name: string;
  socket: Socket;
  token: string;
  messages: unknown[];
  seq: number;
}

describe('playing Define it', () => {
  let harness: Harness;
  let clock: { now: number };
  let roomId: string;
  let host: Socket;
  let tvMessages: unknown[];

  beforeEach(async () => {
    clock = { now: Date.now() };
    harness = await startHarness({ now: () => clock.now, defaultSetup: DECK, tickMs: 5 });
    roomId = await harness.createRoom();
    host = await harness.host(roomId);
    tvMessages = [];
    host.on('view', (view) => tvMessages.push(view));
  });

  afterEach(() => harness.stop());

  const room = () => harness.app.rooms.get(roomId)!;
  const tvView = async (): Promise<HostView> => (await hostHello(host)).view;

  async function join(name: string): Promise<Guest> {
    const socket = await harness.guest(roomId);
    const token = newToken();
    const guest: Guest = { name, socket, token, messages: [], seq: 0 };
    socket.on('view', (view) => guest.messages.push(view));
    const reply = await send(socket, 'guest:join', { token, name });
    expect(reply.status).toBe('joined');
    return guest;
  }

  async function viewOf(guest: Guest): Promise<GuestView> {
    return (await send(guest.socket, 'guest:hello', { token: guest.token })).view;
  }

  function answer(guest: Guest, text: string) {
    guest.seq += 1;
    return send(guest.socket, 'guest:answer', { screenId: room().screenId, seq: guest.seq, text });
  }

  function vote(guest: Guest, entryId: string) {
    guest.seq += 1;
    return send(guest.socket, 'guest:vote', { screenId: room().screenId, seq: guest.seq, entryId });
  }

  async function startWriting(): Promise<void> {
    await command(host, { type: 'next', screenId: 0 });
    await command(host, { type: 'next', screenId: 1 });
    expect((await tvView()).screen.kind).toBe('write');
  }

  async function waitForScreen(id: number): Promise<void> {
    const deadline = Date.now() + 2000;
    while (room().screenId !== id) {
      if (Date.now() > deadline) throw new Error(`stuck on screen ${room().screenId}, wanted ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  /** The first press calls time and gives phones a moment. A second press skips the wait. */
  async function skip(): Promise<void> {
    const { screenId } = room();
    await command(host, { type: 'skipTimer', screenId });
    if (room().screenId === screenId) await command(host, { type: 'skipTimer', screenId });
    // Most tests here aren't about the answers being shown one at a time, so they go past it.
    if ((await tvView()).screen.kind === 'show') {
      await command(host, { type: 'skipTimer', screenId: room().screenId });
    }
  }

  async function entries(): Promise<{ id: string; text: string }[]> {
    const { screen } = await tvView();
    if (screen.kind !== 'vote') throw new Error(`expected voting, on ${screen.kind}`);
    return screen.entries;
  }

  async function entryId(text: string): Promise<string> {
    return (await entries()).find((entry) => entry.text === text)!.id;
  }

  it('plays a full game to the correct final standings', async () => {
    const [alex, sam, priya] = [await join('Alex'), await join('Sam'), await join('Priya')];
    await startWriting();
    expect((await answer(alex, 'A quiet walk at dawn')).ok).toBe(true);
    expect((await answer(sam, 'The sound of rain on paper')).ok).toBe(true);
    await skip();

    // Alex finds the real one, and Sam and Priya both fall for Alex's fake.
    expect((await vote(alex, await entryId(REAL))).ok).toBe(true);
    expect((await vote(sam, await entryId('A quiet walk at dawn'))).ok).toBe(true);
    expect((await vote(priya, await entryId('A quiet walk at dawn'))).ok).toBe(true);
    await skip();

    const reveal = await tvView();
    if (reveal.screen.kind !== 'reveal') throw new Error('expected the reveal');
    expect(reveal.screen.rows.at(-1)).toMatchObject({ text: REAL, real: true, votes: 1 });
    expect(reveal.screen.rows[1]).toMatchObject({ text: 'A quiet walk at dawn', author: 'Alex', votes: 2 });

    const alexResult = await viewOf(alex);
    expect(alexResult.screen).toMatchObject({
      kind: 'reveal',
      result: { wrote: true, foundReal: true, votes: 2, points: 2000, total: 2000, rank: 1 },
    });
    const samResult = await viewOf(sam);
    expect(samResult.screen).toMatchObject({ result: { foundReal: false, votes: 0, points: 0, rank: 2 } });

    // While rows are still arriving, the first press shows them all. The next moves on.
    const revealScreen = room().screenId;
    await command(host, { type: 'next', screenId: revealScreen });
    expect(room().screenId).toBe(revealScreen);
    expect((await viewOf(alex)).screen).toMatchObject({ kind: 'reveal', endsAt: clock.now });
    await command(host, { type: 'next', screenId: revealScreen });
    expect((await tvView()).screen.kind).toBe('write');

    // Word 2: nobody writes, so voting is skipped and the round still ends cleanly.
    await skip();
    expect((await tvView()).screen.kind).toBe('reveal');
    // Only the real answer to show, so there's nothing to wait for.
    await command(host, { type: 'next', screenId: room().screenId });

    const standings = await tvView();
    if (standings.screen.kind !== 'standings') throw new Error('expected standings');
    expect(standings.screen.rows.map((row) => [row.rank, row.name, row.score, row.previous])).toEqual([
      [1, 'Alex', 2000, 0],
      [2, 'Sam', 0, 0],
      [2, 'Priya', 0, 0],
    ]);
    expect((await viewOf(priya)).screen).toMatchObject({ kind: 'standings', rank: 2, score: 0, playerCount: 3 });

    await command(host, { type: 'next', screenId: room().screenId });
    const final = await tvView();
    if (final.screen.kind !== 'final') throw new Error('expected the final');
    expect(final.canAdvance).toBe(false);
    // Sam and Priya tie for 2nd, so they share the silver place and there's no 3rd.
    expect(final.screen.podium.map((row) => [row.rank, row.name])).toEqual([
      [1, 'Alex'],
      [2, 'Sam'],
      [2, 'Priya'],
    ]);
    expect(final.screen.rows).toEqual([]);
    // Each phone waits for its place to land on the TV, with 1st last.
    const alexFinal = (await viewOf(alex)).screen;
    const samFinal = (await viewOf(sam)).screen;
    expect(alexFinal).toMatchObject({ kind: 'final', rank: 1, score: 2000 });
    if (alexFinal.kind !== 'final' || samFinal.kind !== 'final') throw new Error('expected the final');
    expect(samFinal.landsAt).toBeGreaterThan(clock.now);
    expect(alexFinal.landsAt).toBeGreaterThan(samFinal.landsAt);
    expect(alexFinal.landsAt).toBe(final.screen.endsAt + PODIUM.phoneDelayMs);

    // Space shows the whole podium at once, and phones follow straight away.
    await command(host, { type: 'next', screenId: room().screenId });
    expect((await tvView()).screen).toMatchObject({ kind: 'final', endsAt: clock.now, shown: true });
    expect((await viewOf(alex)).screen).toMatchObject({ kind: 'final', landsAt: clock.now + PODIUM.phoneDelayMs });
    expect(await command(host, { type: 'next', screenId: room().screenId })).toEqual({ ok: false, code: 'at_end' });
  });

  describe('answer leak check', () => {
    it('never sends a real answer or an author before the reveal', async () => {
      const [alex, sam, priya] = [await join('Alex'), await join('Sam'), await join('Priya')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await answer(sam, 'The sound of rain on paper');
      await settle();

      // While writing, nobody sees the real answer or anyone else's.
      const writing = JSON.stringify([tvMessages, alex.messages, sam.messages, priya.messages, await tvView()]);
      expect(writing).not.toContain(REAL);
      expect(JSON.stringify([sam.messages, priya.messages, await viewOf(sam)])).not.toContain('A quiet walk at dawn');
      expect(JSON.stringify(tvMessages)).not.toContain('A quiet walk at dawn');

      await skip();
      await settle();

      // While voting, the real answer is on the ballot but nothing marks it out.
      const voting = [await tvView(), await viewOf(alex), await viewOf(priya)];
      for (const view of voting) {
        const text = JSON.stringify(view);
        expect(text).not.toMatch(/"real"|"author|authorId|"votes"|"top"/);
      }
      for (const entry of await entries()) expect(Object.keys(entry).sort()).toEqual(['id', 'text']);
      const everything = JSON.stringify([tvMessages, alex.messages, sam.messages, priya.messages]);
      expect(everything).not.toMatch(/"real":|authorId|"author":/);

      // Scores and other players' names stay off the phones too.
      expect(JSON.stringify(priya.messages)).not.toContain('"Alex"');
    });

    it('tells a guest only their own name and a head count', async () => {
      const alex = await join('Alex');
      await join('Sam');
      await settle();
      expect(JSON.stringify(await viewOf(alex))).not.toContain('Sam');
    });

    it('never sends a token or hash to anyone', async () => {
      const alex = await join('Alex');
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await settle();
      const everything = JSON.stringify([tvMessages, alex.messages, await tvView(), await viewOf(alex)]);
      expect(everything).not.toContain(alex.token);
      expect(everything).not.toContain('tokenHash');
    });
  });

  describe('attacks', () => {
    it('refuses a vote for your own entry, even knowing its id', async () => {
      const [alex] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await skip();
      const own = await entryId('A quiet walk at dawn');
      expect(await vote(alex, own)).toMatchObject({ ok: false, code: 'own_entry' });
      const view = await viewOf(alex);
      if (view.screen.kind !== 'vote') throw new Error('expected voting');
      expect(view.screen.options.map((option) => option.id)).not.toContain(own);
      expect(view.screen.vote).toBeNull();
    });

    it('gives the identical reply for the real answer and for another guest', async () => {
      const [alex, sam, priya] = [await join('Alex'), await join('Sam'), await join('Priya')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      const real = await answer(sam, 'sunlight filtering through leaves');
      const other = await answer(priya, 'a quiet walk at dawn');
      expect(real.code).toBe('too_similar');
      expect(other.code).toBe(real.code);
      const shape = (reply: { view?: unknown }) => {
        const { view: _view, ...rest } = reply;
        return rest;
      };
      expect(shape(other)).toEqual(shape(real));
    });

    it('lets only one of two identical answers through, sent at the same time', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      const replies = await Promise.all([answer(alex, 'A quiet walk at dawn'), answer(sam, 'A quiet walk at dawn')]);
      expect(replies.map((reply) => reply.ok).sort()).toEqual([false, true]);
    });

    it('slows and then stops anyone fishing for the real answer', async () => {
      const alex = await join('Alex');
      await startWriting();
      expect((await answer(alex, REAL)).code).toBe('too_similar');
      expect((await answer(alex, REAL)).code).toBe('too_soon');
      for (let tries = 0; tries < 4; tries += 1) {
        clock.now += 2000;
        expect((await answer(alex, REAL)).code).toBe('too_similar');
      }
      clock.now += 2000;
      const reply = await answer(alex, 'Something else entirely');
      expect(reply.code).toBe('no_more_tries');
      expect(reply.view.screen.triesLeft).toBe(0);
    });

    it('rejects answers and votes after the deadline, by server time', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      const writeScreen = room().screenId;

      clock.now += WRITE_MS + GRACE_MS + 1;
      await waitForScreen(writeScreen + 1);
      const late = await send(sam.socket, 'guest:answer', { screenId: writeScreen, seq: 99, text: 'Too late' });
      expect(late.code).toBe('too_late');

      await skip();
      const realId = await entryId(REAL);
      const voteScreen = room().screenId;
      clock.now += VOTE_MS + GRACE_MS + 1;
      await waitForScreen(voteScreen + 1);
      const lateVote = await send(sam.socket, 'guest:vote', { screenId: voteScreen, seq: 100, entryId: realId });
      expect(lateVote.code).toBe('too_late');
      expect((await viewOf(sam)).screen).toMatchObject({ kind: 'reveal', result: { points: 0 } });
    });

    it('accepts an answer within 1.5 seconds after the deadline, to be fair to slow connections', async () => {
      const alex = await join('Alex');
      await startWriting();
      const local = room();
      const { screenId } = local;
      clock.now += WRITE_MS + GRACE_MS - 200;
      expect(local.screenId).toBe(screenId);
      expect((await answer(alex, 'Only just in time')).ok).toBe(true);
    });

    it('refuses answers and votes sent to the wrong stage', async () => {
      const alex = await join('Alex');
      await startWriting();
      const screenId = room().screenId;
      expect((await send(alex.socket, 'guest:vote', { screenId, seq: 1, entryId: 'abc' })).code).toBe('too_late');
      await skip();
      const answerNow = await send(alex.socket, 'guest:answer', { screenId: room().screenId, seq: 2, text: 'Hello' });
      expect(answerNow.code).toBe('too_late');
    });

    it('refuses extra fields, so nobody can send a score', async () => {
      const alex = await join('Alex');
      await startWriting();
      const screenId = room().screenId;
      for (const payload of [
        { screenId, seq: 1, text: 'Hello', points: 9999 },
        { screenId, seq: 1, text: 'Hello', playerId: 'someone' },
        { screenId, seq: 0, text: 'Hello' },
        { screenId, seq: 1 },
        { screenId, seq: 1, text: 'x'.repeat(1001) },
      ]) {
        expect((await send(alex.socket, 'guest:answer', payload)).code).toBe('bad_request');
      }
    });

    it('refuses answers from a connection with no player', async () => {
      await join('Alex');
      await startWriting();
      const stranger = await harness.guest(roomId);
      const reply = await send(stranger, 'guest:answer', { screenId: room().screenId, seq: 1, text: 'Hello' });
      expect(reply.code).toBe('not_found');
    });

    it('ignores presenter commands from guests', async () => {
      const alex = await join('Alex');
      await startWriting();
      const screenId = room().screenId;
      for (const value of [
        { type: 'skipTimer', screenId },
        { type: 'addTime', screenId },
        { type: 'setPaused', paused: true },
        { type: 'hideEntry', entryId: 'abc' },
      ]) {
        await expect(alex.socket.timeout(100).emitWithAck('host:command', value)).rejects.toThrow();
      }
      expect(room().screenId).toBe(screenId);
    });

    it('stops a removed player from acting, and their token stays blocked', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await answer(sam, 'The sound of rain on paper');
      await skip();
      const alexEntry = await entryId('A quiet walk at dawn');
      await vote(sam, alexEntry);

      const { players } = await tvView();
      await command(host, { type: 'remove', playerId: players.find((player) => player.name === 'Alex')!.id });

      // Their entry is gone, and Sam gets to vote again.
      expect((await entries()).map((entry) => entry.id)).not.toContain(alexEntry);
      const view = await viewOf(sam);
      expect(view.screen).toMatchObject({ kind: 'vote', vote: null, voteCleared: true });

      const back = await harness.guest(roomId);
      expect((await send(back, 'guest:hello', { token: alex.token })).code).toBe('removed');
    });

    it('rejects blocked words, on the server', async () => {
      const alex = await join('Alex');
      await startWriting();
      expect((await answer(alex, 'What a jerk')).code).toBe('answer_blocked');
    });
  });

  describe('repeats on a bad connection', () => {
    it('counts a retried answer once and returns the same result', async () => {
      const alex = await join('Alex');
      await startWriting();
      const payload = { screenId: room().screenId, seq: 7, text: REAL };
      const first = await send(alex.socket, 'guest:answer', payload);
      const again = await send(alex.socket, 'guest:answer', payload);
      expect(first.code).toBe('too_similar');
      expect(again.code).toBe('too_similar');
      // Only one try was used, and the repeat didn't trip the wait between tries either.
      expect(again.view.screen.triesLeft).toBe(4);
    });

    it('ignores a delayed older edit', async () => {
      const alex = await join('Alex');
      await startWriting();
      const { screenId } = room();
      await send(alex.socket, 'guest:answer', { screenId, seq: 5, text: 'The newer answer' });
      const old = await send(alex.socket, 'guest:answer', { screenId, seq: 4, text: 'The older answer' });
      expect(old.code).toBe('stale_action');
      expect((await viewOf(alex)).screen).toMatchObject({ answer: 'The newer answer', lastSeq: 5 });
    });
  });

  describe('timers', () => {
    it('drops to a final 5 seconds once every connected guest is done', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      const { screenId } = room();
      await answer(alex, 'A quiet walk at dawn');
      await settle();
      let view = await tvView();
      if (view.screen.kind !== 'write') throw new Error('expected writing');
      const original = view.screen.timer.endsAt;
      expect(original).toBe(clock.now + WRITE_MS);

      await answer(sam, 'The sound of rain on paper');
      await settle();
      view = await tvView();
      if (view.screen.kind !== 'write') throw new Error('expected writing');
      expect(view.screen.timer.endsAt).toBe(clock.now + 5000);

      // Guests can still edit in those seconds.
      expect((await answer(alex, 'A quiet walk at dusk')).ok).toBe(true);

      clock.now += 5000 + GRACE_MS + 1;
      await waitForScreen(screenId + 1);
    });

    it('waits 10 seconds for someone who just dropped out', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      sam.socket.close();
      await settle();
      const endsAt = () => {
        const { screen } = room().hostView();
        if (screen.kind !== 'write') throw new Error('expected writing');
        return screen.timer.endsAt;
      };
      const original = endsAt();
      expect(original).toBeGreaterThan(clock.now + 5000);
      clock.now += 9000;
      await settle();
      expect(endsAt()).toBe(original);
      clock.now += 2000;
      await settle();
      expect(endsAt()).toBe(clock.now + 5000);
    });

    it('doesn\'t cut the timer short when nobody is connected', async () => {
      const alex = await join('Alex');
      await startWriting();
      alex.socket.close();
      await settle();
      clock.now += 20_000;
      await settle();
      const { screen } = room().hostView();
      if (screen.kind !== 'write') throw new Error('expected writing');
      expect(screen.timer.endsAt).toBeGreaterThan(clock.now + 5000);
    });

    it('adds 15 seconds, which also stops the early finish', async () => {
      const alex = await join('Alex');
      await startWriting();
      const { screenId } = room();
      await command(host, { type: 'addTime', screenId });
      const view = await tvView();
      if (view.screen.kind !== 'write') throw new Error('expected writing');
      expect(view.screen.timer.endsAt).toBe(clock.now + WRITE_MS + 15_000);
      expect(view.screen.timer.totalMs).toBe(WRITE_MS + 15_000);
      await answer(alex, 'A quiet walk at dawn');
      await settle();
      const after = await tvView();
      if (after.screen.kind !== 'write') throw new Error('expected writing');
      expect(after.screen.timer.endsAt).toBe(clock.now + WRITE_MS + 15_000);
    });

    it('pauses and resumes, and time stands still in between', async () => {
      // Sam hasn't answered, so the early finish doesn't apply when the timer resumes.
      const [alex] = [await join('Alex'), await join('Sam')];
      await startWriting();
      const { screenId } = room();
      clock.now += 10_000;
      await command(host, { type: 'setPaused', paused: true });
      // Stating the wanted value twice changes nothing extra.
      await command(host, { type: 'setPaused', paused: true });
      clock.now += 500_000;
      await settle();
      expect(room().screenId).toBe(screenId);
      // Answers still count while paused.
      expect((await answer(alex, 'A quiet walk at dawn')).ok).toBe(true);
      await command(host, { type: 'setPaused', paused: false });
      const view = await tvView();
      if (view.screen.kind !== 'write') throw new Error('expected writing');
      expect(view.screen.timer.endsAt).toBe(clock.now + WRITE_MS - 10_000);
    });

    it('moves on by itself, and Space does nothing during a timed stage', async () => {
      await join('Alex');
      await startWriting();
      const { screenId } = room();
      expect(await command(host, { type: 'next', screenId })).toEqual({ ok: false, code: 'stage_running' });
      expect((await tvView()).canAdvance).toBe(false);
      expect(room().screenId).toBe(screenId);
    });

    it('skips once for a double press of S', async () => {
      const alex = await join('Alex');
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      const { screenId } = room();
      await Promise.all([
        command(host, { type: 'skipTimer', screenId }),
        command(host, { type: 'skipTimer', screenId }),
      ]);
      expect(room().screenId).toBe(screenId + 1);
    });

    it('adds voting time for long ballots', async () => {
      const guests: Guest[] = [];
      for (let index = 0; index < 10; index += 1) guests.push(await join(`Guest ${index}`));
      await startWriting();
      const words = ['apple', 'bridge', 'candle', 'dragon', 'engine', 'forest', 'garden', 'harbor', 'island', 'jungle'];
      for (const [index, guest] of guests.entries()) {
        expect((await answer(guest, `${words[index]} ${words[(index + 3) % 10]}`)).ok).toBe(true);
      }
      await skip();
      const view = await tvView();
      if (view.screen.kind !== 'vote') throw new Error('expected voting');
      expect(view.screen.entries).toHaveLength(11);
      expect(view.screen.timer.totalMs).toBe(VOTE_MS + 3 * 3000);
    });

    it('tells devices the server\'s time', async () => {
      const alex = await join('Alex');
      expect(await send(alex.socket, 'time:sync')).toEqual({ ok: true, now: clock.now });
      expect(await send(host, 'time:sync')).toEqual({ ok: true, now: clock.now });
    });
  });

  describe('moderation', () => {
    it('hides an answer from the TV and every ballot, and refuses to hide the real one', async () => {
      const [alex, sam, priya] = [await join('Alex'), await join('Sam'), await join('Priya')];
      await startWriting();
      await answer(alex, 'Something rude');
      await answer(sam, 'The sound of rain on paper');
      await skip();
      const rude = await entryId('Something rude');
      await vote(priya, rude);

      expect(await command(host, { type: 'hideEntry', entryId: rude })).toEqual({ ok: true });
      expect((await entries()).map((entry) => entry.text)).not.toContain('Something rude');
      expect((await viewOf(priya)).screen).toMatchObject({ vote: null, voteCleared: true });

      const refused = await command(host, { type: 'hideEntry', entryId: await entryId(REAL) });
      expect(refused).toEqual({ ok: false, code: 'cannot_hide' });
      expect((await entries()).map((entry) => entry.text)).toContain(REAL);
    });

    it('blanks an answer after the reveal, without touching the points', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'Something rude');
      await skip();
      const rude = await entryId('Something rude');
      await vote(sam, rude);
      await skip();
      expect(await command(host, { type: 'hideEntry', entryId: rude })).toEqual({ ok: true });
      const view = await tvView();
      if (view.screen.kind !== 'reveal') throw new Error('expected the reveal');
      expect(JSON.stringify(view.screen.rows)).not.toContain('Something rude');
      expect((await viewOf(alex)).screen).toMatchObject({ result: { points: 500 } });
    });

    it('shows on the TV when a guest left the page, with no penalty', async () => {
      const alex = await join('Alex');
      await startWriting();
      await send(alex.socket, 'guest:left');
      expect((await tvView()).players[0]).toMatchObject({ name: 'Alex', leftPage: true });
    });

    it('ignores leaving the page outside a round', async () => {
      const alex = await join('Alex');
      await send(alex.socket, 'guest:left');
      expect((await tvView()).players[0]).toMatchObject({ leftPage: false });
    });
  });

  describe('reconnecting', () => {
    it('returns a guest to the same ballot, with their vote and answer intact', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await skip();
      const realId = await entryId(REAL);
      await vote(sam, realId);
      const before = await viewOf(sam);

      sam.socket.close();
      const back = await harness.guest(roomId);
      const after = (await send(back, 'guest:hello', { token: sam.token })).view as GuestView;
      expect(after.screen).toEqual(before.screen);
      expect(after.screen).toMatchObject({ kind: 'vote', vote: realId });
    });

    it('lets a guest vote after missing the writing stage', async () => {
      await join('Alex');
      const sam = await join('Sam');
      const alexGuest = await join('Priya');
      await startWriting();
      await answer(alexGuest, 'A quiet walk at dawn');
      await skip();
      expect((await vote(sam, await entryId(REAL))).ok).toBe(true);
    });

    it('resumes mid-vote after a server restart: scores safe, timer started again', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await skip();
      const fake = await entryId('A quiet walk at dawn');
      await vote(sam, fake);
      const ballot = (await viewOf(sam)).screen;

      clock.now += 20_000;
      await harness.restart();

      const newHost = await harness.host(roomId);
      const view = (await hostHello(newHost)).view;
      if (view.screen.kind !== 'vote') throw new Error('expected voting');
      expect(view.screen.timer.endsAt).toBe(clock.now + VOTE_MS);
      expect(view.players.every((player) => !player.online)).toBe(true);

      const back = await harness.guest(roomId);
      const restored = (await send(back, 'guest:hello', { token: sam.token })).view as GuestView;
      expect(restored.screen).toEqual({ ...ballot, timer: view.screen.timer });

      await command(newHost, { type: 'skipTimer', screenId: view.screenId });
      await command(newHost, { type: 'skipTimer', screenId: view.screenId });
      const backAlex = await harness.guest(roomId);
      const result = (await send(backAlex, 'guest:hello', { token: alex.token })).view as GuestView;
      expect(result.screen).toMatchObject({ kind: 'reveal', result: { votes: 1, points: 500, total: 500 } });
    });

    it('doesn\'t score a round twice after a restart during the reveal', async () => {
      const [alex, sam] = [await join('Alex'), await join('Sam')];
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await skip();
      await vote(sam, await entryId('A quiet walk at dawn'));
      await skip();
      await harness.restart();
      const back = await harness.guest(roomId);
      const view = (await send(back, 'guest:hello', { token: alex.token })).view as GuestView;
      expect(view.screen).toMatchObject({ kind: 'reveal', result: { total: 500 } });
    });

    it('stores only hashes in saved games', async () => {
      const alex = await join('Alex');
      await startWriting();
      await answer(alex, 'A quiet walk at dawn');
      await harness.app.rooms.flush();
      const stored = await harness.app.storage.get(`rooms/${roomId}.json`);
      expect(stored!.body.toString('utf8')).not.toContain(alex.token);
    });
  });

  it('doesn\'t resend identical views to guests when someone else votes', async () => {
    const [alex, sam, priya] = [await join('Alex'), await join('Sam'), await join('Priya')];
    await startWriting();
    await answer(alex, 'A quiet walk at dawn');
    await skip();
    await settle();
    const before = priya.messages.length;
    await vote(sam, await entryId(REAL));
    await settle();
    expect(priya.messages.length).toBe(before);
    expect(tvMessages.length).toBeGreaterThan(0);
  });
});
