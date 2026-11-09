import { describe, expect, it } from 'vitest';
import { afterAll, beforeAll } from 'vitest';
import type { GuestView, HostView } from '../../shared/protocol.js';
import { command, hostHello, newToken, nextEvent, nextView, PASSWORD, send, startHarness, type Harness } from './helpers.js';

describe('rooms and the lobby', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(() => harness.stop());

  async function guestJoins(room: string, name: string, token = newToken()) {
    const socket = await harness.guest(room);
    const reply = await send(socket, 'guest:join', { token, name });
    return { socket, reply, token };
  }

  it('fills the lobby live and shows the phone a head count', async () => {
    const room = await harness.createRoom();
    const host = await harness.host(room);
    expect((await hostHello(host)).view.players).toEqual([]);

    const arrival = nextView<HostView>(host, (view) => view.players.length === 1);
    const first = await guestJoins(room, 'Alex');
    expect(first.reply).toMatchObject({ ok: true, status: 'joined', view: { you: { name: 'Alex' } } });
    expect((await arrival).players[0]).toMatchObject({ name: 'Alex', online: true });

    const headCount = nextView<GuestView>(first.socket, (view) => view.playerCount === 2);
    await guestJoins(room, 'Sam');
    expect((await headCount).playerCount).toBe(2);
  });

  it('holds 50 guests, refuses the 51st and tells a newcomer', async () => {
    const room = await harness.createRoom();
    const replies = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => (await guestJoins(room, `Guest ${i}`)).reply),
    );
    expect(replies.every((reply) => reply.ok && reply.status === 'joined')).toBe(true);
    expect((await guestJoins(room, 'Late')).reply).toEqual({ ok: false, code: 'room_full' });
    const visitor = await harness.guest(room);
    expect(await send(visitor, 'guest:hello', { token: newToken() })).toMatchObject({ joinState: 'full' });
    harness.sockets.splice(0).forEach((socket) => socket.close());
  });

  it('never counts a resent join twice', async () => {
    const room = await harness.createRoom();
    const token = newToken();
    const socket = await harness.guest(room);
    const replies = await Promise.all([
      send(socket, 'guest:join', { token, name: 'Alex' }),
      send(socket, 'guest:join', { token, name: 'Alex' }),
      send(socket, 'guest:join', { token, name: 'Alex' }),
    ]);
    expect(replies.every((reply) => reply.status === 'joined')).toBe(true);
    const host = await harness.host(room);
    expect((await hostHello(host)).view.players).toHaveLength(1);
  });

  it('returns a guest to their player with the saved token, even when locked', async () => {
    const room = await harness.createRoom();
    const host = await harness.host(room);
    const { socket, token } = await guestJoins(room, 'Alex');

    const offline = nextView<HostView>(host, (view) => view.players[0]?.online === false);
    socket.close();
    await offline;

    await command(host, { type: 'setJoinLocked', locked: true });
    const online = nextView<HostView>(host, (view) => view.players[0]?.online === true);
    const back = await harness.guest(room);
    expect(await send(back, 'guest:hello', { token })).toMatchObject({
      status: 'joined',
      view: { you: { name: 'Alex' } },
    });
    await online;
  });

  it('counts a guest as online until their last connection closes', async () => {
    const room = await harness.createRoom();
    const host = await harness.host(room);
    const { socket, token } = await guestJoins(room, 'Alex');
    const second = await harness.guest(room);
    await send(second, 'guest:hello', { token });
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await hostHello(host)).view.players[0]?.online).toBe(true);
    const offline = nextView<HostView>(host, (view) => view.players[0]?.online === false);
    second.close();
    await offline;
  });

  it('moves one screen when the presenter presses twice, and locks joining at the first game', async () => {
    const room = await harness.createRoom();
    const host = await harness.host(room);
    const { socket } = await guestJoins(room, 'Alex');
    const moved = nextView<GuestView>(socket, (view) => view.screenId === 1);
    const replies = await Promise.all([
      command(host, { type: 'next', screenId: 0 }),
      command(host, { type: 'next', screenId: 0 }),
    ]);
    expect(replies).toEqual([{ ok: true }, { ok: false, code: 'stale_screen' }]);
    expect((await moved).screen).toEqual({ kind: 'title', gameNumber: 1, game: 'define' });
    const view = (await hostHello(host)).view;
    expect(view.screenId).toBe(1);
    expect(view.joinLocked).toBe(true);
    expect((await guestJoins(room, 'Late')).reply).toEqual({ ok: false, code: 'join_locked' });
  });

  it('reopens joining when the presenter unlocks it', async () => {
    const room = await harness.createRoom();
    const host = await harness.host(room);
    await command(host, { type: 'next', screenId: 0 });
    await command(host, { type: 'setJoinLocked', locked: false });
    expect((await guestJoins(room, 'Late')).reply.status).toBe('joined');
  });

  describe('removing a guest', () => {
    it('tells the phone, frees the slot and blocks the token', async () => {
      const room = await harness.createRoom();
      const host = await harness.host(room);
      const { socket, token } = await guestJoins(room, 'Alex');
      const playerId = (await hostHello(host)).view.players[0]!.id;

      const told = nextEvent<string>(socket, 'kicked');
      const closed = nextEvent<string>(socket, 'disconnect');
      expect(await command(host, { type: 'remove', playerId })).toEqual({ ok: true });
      expect(await told).toBe('removed');
      await closed;

      const back = await harness.guest(room);
      expect(await send(back, 'guest:hello', { token })).toEqual({ ok: false, code: 'removed' });
      expect(await send(back, 'guest:join', { token, name: 'Alex2' })).toEqual({ ok: false, code: 'removed' });
      expect((await guestJoins(room, 'Alex')).reply.status).toBe('joined');
    });

    it('reports a player that is already gone', async () => {
      const room = await harness.createRoom();
      const host = await harness.host(room);
      expect(await command(host, { type: 'remove', playerId: 'nobody' })).toEqual({
        ok: false,
        code: 'not_found',
      });
    });
  });

  describe('new-phone rejoin', () => {
    async function offlineAlex(room: string) {
      const host = await harness.host(room);
      const old = await guestJoins(room, 'Alex');
      const gone = nextView<HostView>(host, (view) => view.players[0]?.online === false);
      old.socket.close();
      await gone;
      return { host, oldToken: old.token };
    }

    it('asks on the TV, then moves the player on approval', async () => {
      const room = await harness.createRoom();
      const { host, oldToken } = await offlineAlex(room);

      const prompted = nextView<HostView>(host, (view) => view.rejoinRequests.length === 1);
      const asking = await guestJoins(room, 'alex');
      expect(asking.reply).toMatchObject({ ok: true, status: 'pending' });
      const prompt = (await prompted).rejoinRequests[0]!;
      expect(prompt.name).toBe('Alex');

      const result = nextEvent<string>(asking.socket, 'rejoin:result');
      expect(await command(host, { type: 'answerRejoin', requestId: prompt.id, approve: true })).toEqual({
        ok: true,
      });
      expect(await result).toBe('approved');

      expect(await send(asking.socket, 'guest:hello', { token: asking.token })).toMatchObject({
        status: 'joined',
        view: { you: { name: 'Alex' } },
      });
      expect((await hostHello(host)).view.players).toHaveLength(1);

      const old = await harness.guest(room);
      expect(await send(old, 'guest:hello', { token: oldToken })).toEqual({ ok: false, code: 'superseded' });
    });

    it('tells the phone when the presenter declines', async () => {
      const room = await harness.createRoom();
      const { host, oldToken } = await offlineAlex(room);
      const prompted = nextView<HostView>(host, (view) => view.rejoinRequests.length === 1);
      const asking = await guestJoins(room, 'Alex');
      const prompt = (await prompted).rejoinRequests[0]!;
      const result = nextEvent<string>(asking.socket, 'rejoin:result');
      await command(host, { type: 'answerRejoin', requestId: prompt.id, approve: false });
      expect(await result).toBe('denied');
      const old = await harness.guest(room);
      expect(await send(old, 'guest:hello', { token: oldToken })).toMatchObject({ status: 'joined' });
    });

    it('cancels the request when the real guest returns', async () => {
      const room = await harness.createRoom();
      const { host, oldToken } = await offlineAlex(room);
      const prompted = nextView<HostView>(host, (view) => view.rejoinRequests.length === 1);
      const asking = await guestJoins(room, 'Alex');
      await prompted;
      const result = nextEvent<string>(asking.socket, 'rejoin:result');
      const owner = await harness.guest(room);
      await send(owner, 'guest:hello', { token: oldToken });
      expect(await result).toBe('cancelled');
    });
  });

  describe('attacks', () => {
    it('refuses presenter connections with no session or a forged one', async () => {
      const room = await harness.createRoom();
      await expect(harness.host(room, 'tp_admin=none')).rejects.toThrow('unauthorized');
      await expect(harness.host(room, 'tp_admin=v1.99999999999.forged')).rejects.toThrow('unauthorized');
    });

    it('refuses a presenter connection from another site', async () => {
      const room = await harness.createRoom();
      const { io } = await import('socket.io-client');
      const socket = io(harness.url, {
        auth: { room, role: 'host' },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        extraHeaders: { cookie: await harness.signIn(), origin: 'https://evil.example' },
      });
      harness.sockets.push(socket);
      const message = await new Promise<string>((resolve) => socket.once('connect_error', (e) => resolve(e.message)));
      expect(message).toBe('unauthorized');
    });

    it('ignores presenter commands from a guest connection', async () => {
      const room = await harness.createRoom();
      const host = await harness.host(room);
      const { socket } = await guestJoins(room, 'Mallory');
      const silence = socket.timeout(200).emitWithAck('host:command', { type: 'next', screenId: 0 });
      await expect(silence).rejects.toThrow();
      expect((await hostHello(host)).view.screenId).toBe(0);
    });

    it('refuses to connect to a room that does not exist', async () => {
      await expect(harness.guest('A'.repeat(22))).rejects.toThrow('room_missing');
      await expect(harness.guest('../../etc/passwd')).rejects.toThrow('bad_request');
    });

    it.each([
      ['no token', { name: 'Alex' }],
      ['a short token', { token: 'abc', name: 'Alex' }],
      ['a name of the wrong type', { token: newToken(), name: { $gt: '' } }],
      ['a very long name', { token: newToken(), name: 'x'.repeat(5000) }],
      ['an extra field', { token: newToken(), name: 'Alex', score: 9999 }],
      ['a non-object', 'Alex'],
    ])('rejects a join with %s', async (_label, payload) => {
      const room = await harness.createRoom();
      const socket = await harness.guest(room);
      expect(await send(socket, 'guest:join', payload)).toEqual({ ok: false, code: 'bad_request' });
    });

    it('refuses invalid presenter commands', async () => {
      const room = await harness.createRoom();
      const host = await harness.host(room);
      for (const payload of [{ type: 'next' }, { type: 'grantPoints', amount: 9 }, { type: 'next', screenId: -1 }]) {
        expect(await send(host, 'host:command', payload)).toEqual({ ok: false, code: 'bad_request' });
      }
    });

    it("can't take over a player by typing their name while they're online", async () => {
      const room = await harness.createRoom();
      await guestJoins(room, 'Alex');
      expect((await guestJoins(room, 'ＡＬＥＸ')).reply).toEqual({ ok: false, code: 'name_taken' });
    });

    it('keeps one connection to one guest', async () => {
      const room = await harness.createRoom();
      const socket = await harness.guest(room);
      await send(socket, 'guest:join', { token: newToken(), name: 'One' });
      expect(await send(socket, 'guest:join', { token: newToken(), name: 'Two' })).toEqual({
        ok: false,
        code: 'bad_request',
      });
    });

    it("keeps one room's crowd from filling the server for every other game", async () => {
      await harness.stop();
      harness = await startHarness({ maxRoomConnections: 5 });
      const crowded = await harness.createRoom();
      const quiet = await harness.createRoom();
      const crowd = await Promise.all(Array.from({ length: 5 }, () => harness.guest(crowded)));
      await expect(harness.guest(crowded)).rejects.toThrow('slow_down');
      await expect(harness.guest(quiet)).resolves.toBeTruthy();
      // The TV still gets in, so the presenter can remove people or end the game.
      await expect(harness.host(crowded)).resolves.toBeTruthy();
      // Room again once someone leaves.
      const leaving = crowd[0]!;
      const gone = new Promise((resolve) => leaving.once('disconnect', resolve));
      leaving.close();
      await gone;
      // The server hears about the close a moment after the phone does.
      let rejoined = null;
      for (let attempt = 0; attempt < 20 && !rejoined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        rejoined = await harness.guest(crowded).catch(() => null);
      }
      expect(rejoined).toBeTruthy();
    });

    it('slows down a connection that floods messages', async () => {
      const room = await harness.createRoom();
      const socket = await harness.guest(room);
      const token = newToken();
      const replies = await Promise.all(
        Array.from({ length: 60 }, () => send(socket, 'guest:hello', { token })),
      );
      expect(replies.filter((reply) => reply.code === 'slow_down').length).toBeGreaterThan(0);
    });

    it('never sends tokens or hashes to anyone', async () => {
      const room = await harness.createRoom();
      const host = await harness.host(room);
      const { hashToken } = await import('../../server/session/room.js');
      const seen: string[] = [];
      host.onAny((_event, ...args) => seen.push(JSON.stringify(args)));
      const { socket, token, reply } = await guestJoins(room, 'Alex');
      socket.onAny((_event, ...args) => seen.push(JSON.stringify(args)));
      seen.push(JSON.stringify(reply));
      await new Promise((resolve) => setTimeout(resolve, 80));
      seen.push(JSON.stringify(await hostHello(host)));
      const all = seen.join('\n');
      expect(all).toContain('Alex');
      expect(all).not.toContain(token);
      expect(all).not.toContain(hashToken(token));
    });
  });

  describe('presenter sign-in', () => {
    const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${harness.url}${path}`, {
        method: 'POST',
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    it('protects the room routes', async () => {
      expect((await post('/api/admin/rooms')).status).toBe(401);
      expect((await fetch(`${harness.url}/api/admin/rooms`)).status).toBe(401);
    });

    it('sets a hardened cookie on the right password', async () => {
      const response = await post('/api/admin/login', { password: PASSWORD });
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).not.toContain(PASSWORD);
    });

    it('marks the cookie Secure over HTTPS', async () => {
      const response = await post('/api/admin/login', { password: PASSWORD }, { 'x-forwarded-proto': 'https' });
      expect(response.headers.get('set-cookie')).toContain('Secure');
    });

    it('refuses a wrong password and malformed sign-ins', async () => {
      expect((await post('/api/admin/login', { password: 'wrong' })).status).toBe(401);
      expect((await post('/api/admin/login', { password: 7 })).status).toBe(400);
    });
  });

  describe('restarting the server', () => {
    it('restores the game, and phones return with the same token', async () => {
      const local = await startHarness();
      try {
        const room = await local.createRoom();
        const host = await local.host(room);
        const socket = await local.guest(room);
        const token = newToken();
        await send(socket, 'guest:join', { token, name: 'Alex' });
        await command(host, { type: 'next', screenId: 0 });

        await local.restart();

        const back = await local.guest(room);
        expect(await send(back, 'guest:hello', { token })).toMatchObject({
          status: 'joined',
          view: { you: { name: 'Alex' }, screenId: 1 },
        });
        const newHost = await local.host(room);
        const view = (await hostHello(newHost)).view;
        expect(view.joinLocked).toBe(true);
        expect(view.players).toHaveLength(1);
      } finally {
        await local.stop();
      }
    });

    it('stores hashes only', async () => {
      const local = await startHarness();
      try {
        const room = await local.createRoom();
        const socket = await local.guest(room);
        const token = newToken();
        await send(socket, 'guest:join', { token, name: 'Alex' });
        await local.app.rooms.flush();
        const stored = await local.app.storage.get(`rooms/${room}.json`);
        const text = stored!.body.toString('utf8');
        expect(text).toContain('Alex');
        expect(text).not.toContain(token);
      } finally {
        await local.stop();
      }
    });

    it('saves a new player within a moment, without waiting for a screen change', async () => {
      const local = await startHarness();
      try {
        const room = await local.createRoom();
        const socket = await local.guest(room);
        await send(socket, 'guest:join', { token: newToken(), name: 'Alex' });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const stored = await local.app.storage.get(`rooms/${room}.json`);
        expect(stored!.body.toString('utf8')).toContain('Alex');
      } finally {
        await local.stop();
      }
    });
  });
});
