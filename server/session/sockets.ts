import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Server, Socket } from 'socket.io';
import type { z } from 'zod';
import {
  emptySchema,
  guestAnswerSchema,
  guestHelloSchema,
  guestJoinSchema,
  guestPickSchema,
  guestPinSchema,
  guestVoteSchema,
  handshakeSchema,
  hostCommandSchema,
} from '../../shared/messages.js';
import type {
  ActionReply,
  CommandReply,
  ErrorCode,
  Failure,
  GuestStatus,
  HostCommand,
  KickReason,
  RejoinResult,
} from '../../shared/protocol.js';
import { overHttps, type AdminAuth } from '../auth.js';
import { visitorKey } from '../client-address.js';
import { TokenBucket } from './rate-limit.js';
import type { RoomManager } from './manager.js';
import { hashToken, type ClosedRequest, type Room } from './room.js';

const BROADCAST_DELAY_MS = 30;
const REQUEST_SWEEP_MS = 5000;
const MAX_CONNECTIONS = 500;
/** Room past MAX_CONNECTIONS kept for signed-in TVs, so a crowd of strangers can't lock them out. */
const HOST_HEADROOM = 50;
/** How often each TV's session is checked again, so one that has expired stops getting the game. */
const SESSION_CHECK_MS = 60 * 1000;
/**
 * Guest connections per room: enough for a full room with a second tab each and phones waiting to rejoin. One guest
 * who knows a single room's link can't fill the whole server and lock every other game out.
 */
const MAX_ROOM_CONNECTIONS = 150;
/**
 * Connections from one visitor address, when a trusted proxy says what it is. A whole party can
 * share one address on venue wifi, so this is generous. It stops one machine from taking every
 * connection the server has.
 */
const MAX_ADDRESS_CONNECTIONS = 120;
const DEFAULT_TICK_MS = 100;

interface SocketState {
  roomId: string;
  role: 'guest' | 'host';
  playerId: string | null;
  tokenHash: string | null;
  bucket: TokenBucket;
}

type Ack = (reply: unknown) => void;

/** Counts one more against `key`, and returns what takes it off again. */
function count(counts: Map<string, number>, key: string): () => void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return () => {
    const left = (counts.get(key) ?? 1) - 1;
    if (left > 0) counts.set(key, left);
    else counts.delete(key);
  };
}

/** Every connection to a room, host and guests alike, whether or not they've joined yet. */
const roomChannel = (roomId: string) => `room:${roomId}`;
const hostChannel = (roomId: string) => `host:${roomId}`;
const playerChannel = (roomId: string, playerId: string) => `player:${roomId}:${playerId}`;
const tokenChannel = (roomId: string, tokenHash: string) => `token:${roomId}:${tokenHash}`;

export interface Sessions {
  /** Tells everyone in a deleted room that the game is over, then lets them go. */
  endRoom(roomId: string): void;
  close(): void;
}

export function registerSessions(
  io: Server,
  rooms: RoomManager,
  auth: AdminAuth,
  options: {
    tickMs?: number;
    maxRoomConnections?: number;
    /** The visitor's address, or null when it can't be known (no trusted proxy). */
    addressOf?: (remote: string | undefined, headers: IncomingHttpHeaders) => string | null;
    maxAddressConnections?: number;
    /** Refuses connections that didn't arrive over HTTPS. */
    forceHttps?: boolean;
    sessionCheckMs?: number;
  } = {},
): Sessions {
  const findAddress = options.addressOf ?? (() => null);
  const addressOf = (request: IncomingMessage) => {
    const found = findAddress(request.socket.remoteAddress, request.headers);
    return found && visitorKey(found);
  };
  const maxAddressConnections = options.maxAddressConnections ?? MAX_ADDRESS_CONNECTIONS;
  const maxRoomConnections = options.maxRoomConnections ?? MAX_ROOM_CONNECTIONS;
  const pendingBroadcasts = new Map<string, NodeJS.Timeout>();
  /** What each guest last received, so a vote elsewhere doesn't resend 50 identical ballots. */
  const lastSent = new Map<string, string>();

  /** Sends each client only its own view. Batched, so 50 people joining at once stays cheap. */
  function broadcast(room: Room): void {
    if (pendingBroadcasts.has(room.id)) return;
    const timer = setTimeout(() => {
      pendingBroadcasts.delete(room.id);
      io.to(hostChannel(room.id)).emit('view', room.hostView());
      for (const playerId of room.playerIds) {
        const view = room.guestView(playerId);
        if (!view) continue;
        const { version: _version, ...content } = view;
        const fingerprint = JSON.stringify(content);
        const channel = playerChannel(room.id, playerId);
        if (lastSent.get(channel) === fingerprint) continue;
        lastSent.set(channel, fingerprint);
        io.to(channel).emit('view', view);
      }
    }, BROADCAST_DELAY_MS);
    timer.unref();
    pendingBroadcasts.set(room.id, timer);
  }

  function changed(room: Room, options: { immediate?: boolean } = {}): void {
    rooms.changed(room.id, options);
    broadcast(room);
  }

  function notifyClosed(room: Room, closed: ClosedRequest[]): void {
    for (const { tokenHash, result } of closed) {
      io.to(tokenChannel(room.id, tokenHash)).emit('rejoin:result', result);
    }
  }

  function kick(room: Room, tokenHash: string, reason: KickReason): void {
    const channel = tokenChannel(room.id, tokenHash);
    io.to(channel).emit('kicked', reason);
    io.in(channel).disconnectSockets(true);
  }

  /** Marks this connection as belonging to a player and counts it towards being online. */
  function attachPlayer(socket: Socket, room: Room, playerId: string): void {
    const state = socket.data as SocketState;
    if (state.playerId === playerId) return;
    state.playerId = playerId;
    void socket.join(playerChannel(room.id, playerId));
    notifyClosed(room, room.connect(playerId, rooms.now()));
    changed(room);
  }

  /** One connection speaks for one guest, so it can't collect several players. */
  function holdsOtherToken(socket: Socket, tokenHash: string): boolean {
    const held = (socket.data as SocketState).tokenHash;
    return held !== null && held !== tokenHash;
  }

  function attachToken(socket: Socket, room: Room, tokenHash: string): void {
    const state = socket.data as SocketState;
    if (state.tokenHash === tokenHash) return;
    state.tokenHash = tokenHash;
    void socket.join(tokenChannel(room.id, tokenHash));
  }

  /** One wrapper for every message: rate limit, strict parsing, and always a reply. */
  function on<S extends z.ZodType>(
    socket: Socket,
    event: string,
    schema: S,
    handler: (payload: z.infer<S>, room: Room) => unknown,
  ): void {
    const state = socket.data as SocketState;
    socket.on(event, (payload: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      const reply = ack as Ack;
      const fail = (code: ErrorCode) => reply({ ok: false, code });
      if (!state.bucket.take(rooms.now())) return fail('slow_down');
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return fail('bad_request');
      const room = rooms.get(state.roomId);
      if (!room) return fail('room_missing');
      reply(handler(parsed.data, room));
    });
  }

  function statusFor(room: Room, playerId: string): GuestStatus | Failure {
    const view = room.guestView(playerId);
    return view ? { ok: true, status: 'joined', view } : { ok: false, code: 'not_found' };
  }

  /** Replies with the guest's fresh view, so a phone never shows a moment of old state. */
  function replyToAction(
    socket: Socket,
    room: Room,
    action: (playerId: string, now: number) => CommandReply,
  ): ActionReply {
    const { playerId } = socket.data as SocketState;
    if (!playerId) return { ok: false, code: 'not_found' };
    const result = action(playerId, rooms.now());
    changed(room);
    const view = room.guestView(playerId);
    if (!view) return { ok: false, code: 'not_found' };
    return result.ok ? { ok: true, view } : { ok: false, code: result.code, view };
  }

  function registerGuest(socket: Socket): void {
    on(socket, 'guest:hello', guestHelloSchema, ({ token }, room) => {
      const tokenHash = hashToken(token);
      if (holdsOtherToken(socket, tokenHash)) return { ok: false, code: 'bad_request' };
      const known = room.lookupToken(tokenHash);
      if (known.kind === 'revoked') return { ok: false, code: known.reason };
      attachToken(socket, room, tokenHash);
      if (known.kind === 'player') {
        attachPlayer(socket, room, known.playerId);
        return statusFor(room, known.playerId);
      }
      if (known.kind === 'pending') return { ok: true, status: 'pending', title: room.title };
      return { ok: true, status: 'new', title: room.title, joinState: room.joinState };
    });

    on(socket, 'guest:join', guestJoinSchema, ({ token, name }, room) => {
      const tokenHash = hashToken(token);
      if (holdsOtherToken(socket, tokenHash)) return { ok: false, code: 'bad_request' };
      if (!rooms.allowJoinAttempt(room.id)) return { ok: false, code: 'slow_down' };
      const outcome = room.join(tokenHash, name, rooms.now());
      if (outcome.kind === 'refused') return { ok: false, code: outcome.code };
      attachToken(socket, room, tokenHash);
      if (outcome.kind === 'pending') {
        if (outcome.closed) notifyClosed(room, outcome.closed);
        if (outcome.created) changed(room);
        return { ok: true, status: 'pending', title: room.title };
      }
      attachPlayer(socket, room, outcome.playerId);
      return statusFor(room, outcome.playerId);
    });

    on(socket, 'guest:answer', guestAnswerSchema, ({ screenId, seq, text }, room) =>
      replyToAction(socket, room, (playerId, now) => room.submitAnswer(playerId, screenId, seq, text, now)),
    );

    on(socket, 'guest:vote', guestVoteSchema, ({ screenId, seq, entryId }, room) =>
      replyToAction(socket, room, (playerId, now) => room.submitVote(playerId, screenId, seq, entryId, now)),
    );

    on(socket, 'guest:pin', guestPinSchema, ({ screenId, seq, lat, lng }, room) =>
      replyToAction(socket, room, (playerId, now) => room.submitPin(playerId, screenId, seq, lat, lng, now)),
    );

    on(socket, 'guest:pick', guestPickSchema, ({ screenId, seq, option }, room) =>
      replyToAction(socket, room, (playerId, now) => room.submitPick(playerId, screenId, seq, option, now)),
    );

    on(socket, 'guest:left', emptySchema, (_payload, room) => {
      const { playerId } = socket.data as SocketState;
      if (!playerId) return { ok: false, code: 'not_found' };
      if (room.markLeftPage(playerId, rooms.now())) changed(room);
      return { ok: true };
    });

    socket.on('disconnect', () => {
      const state = socket.data as SocketState;
      const room = rooms.get(state.roomId);
      if (!room || !state.playerId) return;
      room.disconnect(state.playerId, rooms.now());
      changed(room);
    });
  }

  function runCommand(command: HostCommand, room: Room): CommandReply {
    const outcome = applyCommand(command, room, rooms.now());
    if (outcome.ok) changed(room, { immediate: true });
    return outcome;
  }

  function applyCommand(command: HostCommand, room: Room, now: number): CommandReply {
    switch (command.type) {
      case 'next':
        return room.next(command.screenId, now);
      case 'skipTimer':
        return room.skipTimer(command.screenId, now);
      case 'addTime':
        return room.addTime(command.screenId, now);
      case 'setPaused':
        return room.setPaused(command.paused, now);
      case 'hideEntry':
        return room.hideEntry(command.entryId, now);
      case 'setJoinLocked':
        room.setJoinLocked(command.locked, now);
        return { ok: true };
      case 'remove': {
        const removed = room.remove(command.playerId, now);
        if (!removed) return { ok: false, code: 'not_found' };
        notifyClosed(room, removed.closed);
        kick(room, removed.tokenHash, 'removed');
        return { ok: true };
      }
      case 'answerRejoin': {
        const answer = room.answerRejoin(command.requestId, command.approve, now);
        if (!answer) return { ok: false, code: 'not_found' };
        if (answer.oldHash) kick(room, answer.oldHash, 'superseded');
        const result: RejoinResult = command.approve && answer.oldHash ? 'approved' : 'denied';
        // Sent to the new phone, which then says hello again and lands in the game.
        io.to(tokenChannel(room.id, answer.requesterHash)).emit('rejoin:result', result);
        return { ok: true };
      }
    }
  }

  function registerHost(socket: Socket): void {
    const { roomId } = socket.data as SocketState;
    void socket.join(hostChannel(roomId));
    on(socket, 'host:hello', emptySchema, (_payload, room) => ({ ok: true, view: room.hostView() }));
    on(socket, 'host:command', hostCommandSchema, (command, room) => {
      // Checked on every command too, so an expired session can't keep driving the game.
      if (!auth.isSignedIn(socket.handshake.headers)) return { ok: false, code: 'unauthorized' };
      return runCommand(command, room);
    });
  }

  // Every connection counts from its very first request, before it says which room it wants.
  // One that never says, or that the checks below refuse, still holds its place until the
  // connect timeout, so these ceilings are what stop idle connections from filling the server.
  const addressConnections = new Map<string, number>();
  io.engine.opts.allowRequest = (request: IncomingMessage, callback: (error: string | null | undefined, ok: boolean) => void) => {
    if (options.forceHttps && !overHttps(request.headers)) return callback('https_only', false);
    const total = io.engine.clientsCount;
    // Signed-in TVs get some room past the ceiling, so a crowd of strangers can't lock them out.
    if (total >= MAX_CONNECTIONS + HOST_HEADROOM) return callback('slow_down', false);
    if (total >= MAX_CONNECTIONS && !auth.isSignedIn(request.headers)) return callback('slow_down', false);
    const address = addressOf(request);
    if (address && (addressConnections.get(address) ?? 0) >= maxAddressConnections) return callback('slow_down', false);
    callback(null, true);
  };
  io.engine.on('connection', (raw: { request: IncomingMessage; once(event: 'close', listener: () => void): void }) => {
    const address = addressOf(raw.request);
    if (address) raw.once('close', count(addressConnections, address));
  });

  /** Open guest connections per room, counted from when they connect until they close. */
  const guestConnections = new Map<string, number>();

  io.use((socket, next) => {
    const handshake = handshakeSchema.safeParse(socket.handshake.auth);
    if (!handshake.success) return next(new Error('bad_request'));
    const { room: roomId, role } = handshake.data;
    if (!rooms.get(roomId)) return next(new Error('room_missing'));
    // Only guests count, so a crowd of strangers can never lock the signed-in TV out of its own game.
    if (role === 'guest' && (guestConnections.get(roomId) ?? 0) >= maxRoomConnections) {
      return next(new Error('slow_down'));
    }
    if (role === 'host') {
      const { origin, host } = socket.handshake.headers;
      const sameOrigin = !origin || (URL.canParse(origin) && new URL(origin).host === host);
      if (!sameOrigin || !auth.isSignedIn(socket.handshake.headers)) return next(new Error('unauthorized'));
    }
    const state: SocketState = {
      roomId,
      role,
      playerId: null,
      tokenHash: null,
      bucket: new TokenBucket(30, 10, rooms.now()),
    };
    socket.data = state;
    next();
  });

  io.on('connection', (socket) => {
    const { roomId, role } = socket.data as SocketState;
    if (role === 'guest') socket.on('disconnect', count(guestConnections, roomId));
    void socket.join(roomChannel(roomId));
    // Lets each device work out how far its clock is from the server's.
    on(socket, 'time:sync', emptySchema, () => ({ ok: true, now: rooms.now() }));
    if (role === 'host') registerHost(socket);
    else registerGuest(socket);
  });

  // The session is checked when a TV connects and on every command, but a TV only watching
  // would otherwise keep getting every screen, answers included, after its session ran out.
  const sessionChecker = setInterval(() => {
    for (const socket of io.of('/').sockets.values()) {
      const state = socket.data as SocketState | undefined;
      if (state?.role !== 'host') continue;
      if (!rooms.get(state.roomId) || !auth.isSignedIn(socket.handshake.headers)) socket.disconnect(true);
    }
  }, options.sessionCheckMs ?? SESSION_CHECK_MS);
  sessionChecker.unref();

  const sweeper = setInterval(() => {
    for (const room of rooms.list()) {
      if (!room.hasPendingRequests) continue;
      const closed = room.expireRequests(rooms.now());
      if (closed.length === 0) continue;
      notifyClosed(room, closed);
      changed(room);
    }
    void rooms.sweep();
  }, REQUEST_SWEEP_MS);
  sweeper.unref();

  // Deadlines live here on the server, so no phone can stretch one.
  const ticker = setInterval(() => {
    for (const room of rooms.list()) {
      const outcome = room.tick(rooms.now());
      if (outcome !== 'none') changed(room, { immediate: outcome === 'stage' });
    }
  }, options.tickMs ?? DEFAULT_TICK_MS);
  ticker.unref();

  return {
    endRoom(roomId) {
      const pending = pendingBroadcasts.get(roomId);
      if (pending) clearTimeout(pending);
      pendingBroadcasts.delete(roomId);
      const prefix = playerChannel(roomId, '');
      for (const channel of lastSent.keys()) if (channel.startsWith(prefix)) lastSent.delete(channel);
      const channel = roomChannel(roomId);
      io.to(channel).emit('kicked', 'ended');
      io.in(channel).disconnectSockets(true);
    },
    close() {
      clearInterval(sweeper);
      clearInterval(sessionChecker);
      clearInterval(ticker);
      for (const timer of pendingBroadcasts.values()) clearTimeout(timer);
      pendingBroadcasts.clear();
    },
  };
}
