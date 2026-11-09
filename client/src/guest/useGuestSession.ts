import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { LEFT_PAGE_AFTER_MS } from '../../../shared/constants.js';
import type {
  ActionReply,
  ErrorCode,
  GoneReason,
  GuestStatus,
  GuestView,
  HelloReply,
  JoinReply,
  JoinState,
  RejoinResult,
} from '../../../shared/protocol.js';
import { keepClockSynced } from '../net/clock.js';
import { openSocket, reconnectWithNetwork, safeStorage, sendUntilReplied } from '../net/socket.js';

export type Stage =
  | { stage: 'connecting' }
  | { stage: 'form'; title: string; joinState: JoinState; notice?: ErrorCode | RejoinResult }
  | { stage: 'pending'; title: string }
  | { stage: 'in'; view: GuestView }
  | { stage: 'gone'; reason: GoneReason | 'missing' };

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Created once and saved before anything is sent, so a dropout can't lose this guest's identity. */
function loadToken(room: string): string {
  const key = `tp:token:${room}`;
  let token = safeStorage.get(key);
  if (!token) {
    token = createToken();
    safeStorage.set(key, token);
  }
  return token;
}

const WAKE_RETRY_MS = 1500;

export function useGuestSession(room: string) {
  const [stage, setStage] = useState<Stage>({ stage: 'connecting' });
  const [online, setOnline] = useState(false);
  const [offset, setOffset] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const token = useRef(loadToken(room));
  const lastVersion = useRef(0);
  const currentScreen = useRef<number | null>(null);
  const lastSeq = useRef(0);

  /** A late packet can't send the screen backward. */
  const showView = useCallback((view: GuestView) => {
    if (view.version < lastVersion.current) return;
    lastVersion.current = view.version;
    currentScreen.current = view.screenId;
    setStage({ stage: 'in', view });
  }, []);

  useEffect(() => {
    const socket = openSocket(room, 'guest');
    socketRef.current = socket;
    let active = true;
    let helloGeneration = 0;
    let lastTitle = '';

    const finish = (reason: GoneReason | 'missing') => {
      if (!active) return;
      setStage({ stage: 'gone', reason });
      socket.disconnect();
    };

    const apply = (reply: GuestStatus) => {
      if (reply.status === 'joined') {
        lastTitle = reply.view.title;
        showView(reply.view);
      } else if (reply.status === 'pending') {
        lastTitle = reply.title;
        setStage({ stage: 'pending', title: reply.title });
      } else {
        lastTitle = reply.title;
        // Never wipes a name someone is typing: only refreshes the facts around the form.
        setStage((current) =>
          current.stage === 'form'
            ? { ...current, title: reply.title, joinState: reply.joinState }
            : { stage: 'form', title: reply.title, joinState: reply.joinState },
        );
      }
    };

    const hello = async () => {
      helloGeneration += 1;
      const generation = helloGeneration;
      const reply = await sendUntilReplied<HelloReply>(
        socket,
        'guest:hello',
        { token: token.current },
        () => active && generation === helloGeneration,
      );
      if (!reply || !active || generation !== helloGeneration) return;
      if (reply.ok) apply(reply);
      else if (reply.code === 'removed' || reply.code === 'superseded') finish(reply.code);
      else if (reply.code === 'room_missing') finish('missing');
      else window.setTimeout(() => void hello(), WAKE_RETRY_MS);
    };

    socket.on('connect', () => {
      setOnline(true);
      // A reconnect always takes the current state, even after a server restart resets versions.
      lastVersion.current = 0;
      void hello();
    });
    socket.on('disconnect', () => setOnline(false));
    socket.on('connect_error', (error) => {
      if (error.message === 'room_missing') {
        finish('missing');
      } else if (!socket.active) {
        // The server refused this attempt, so Socket.IO won't retry by itself.
        window.setTimeout(() => {
          if (active) socket.connect();
        }, WAKE_RETRY_MS);
      }
    });
    socket.on('view', showView);
    socket.on('kicked', (reason: GoneReason) => finish(reason));
    socket.on('rejoin:result', (result: RejoinResult) => {
      if (result === 'approved') {
        void hello();
      } else {
        setStage({ stage: 'form', title: lastTitle, joinState: 'open', notice: result });
        void hello();
      }
    });

    const stopWatching = reconnectWithNetwork(socket);
    const stopSyncing = keepClockSynced(socket, setOffset);

    return () => {
      active = false;
      stopWatching();
      stopSyncing();
      socket.close();
      socketRef.current = null;
    };
  }, [room, showView]);

  /** Resolves when there's a result. Retries by itself through a dropout. */
  const join = useCallback(async (name: string): Promise<ErrorCode | null> => {
    const socket = socketRef.current;
    if (!socket) return null;
    const reply = await sendUntilReplied<JoinReply>(socket, 'guest:join', { token: token.current, name });
    if (!reply) return null;
    if (!reply.ok) {
      if (reply.code === 'removed' || reply.code === 'superseded') {
        setStage({ stage: 'gone', reason: reply.code });
        socket.disconnect();
        return null;
      }
      return reply.code;
    }
    if (reply.status === 'joined') showView(reply.view);
    else if (reply.status === 'pending') setStage({ stage: 'pending', title: reply.title });
    return null;
  }, [showView]);

  /**
   * Retries by itself through a dropout, and stops once the screen has moved on. Each
   * action gets the next number, so a repeat changes nothing and an old one is ignored.
   */
  const act = useCallback(
    async (event: string, screenId: number, seenSeq: number, body: object): Promise<ActionReply | null> => {
      const socket = socketRef.current;
      if (!socket) return null;
      lastSeq.current = Math.max(lastSeq.current, seenSeq) + 1;
      const reply = await sendUntilReplied<ActionReply>(
        socket,
        event,
        { screenId, seq: lastSeq.current, ...body },
        () => currentScreen.current === screenId,
      );
      if (reply?.view) showView(reply.view);
      return reply;
    },
    [showView],
  );

  const sendAnswer = useCallback(
    (screenId: number, seenSeq: number, text: string) => act('guest:answer', screenId, seenSeq, { text }),
    [act],
  );

  const sendVote = useCallback(
    (screenId: number, seenSeq: number, entryId: string) => act('guest:vote', screenId, seenSeq, { entryId }),
    [act],
  );

  const sendPin = useCallback(
    (screenId: number, seenSeq: number, lat: number, lng: number) => act('guest:pin', screenId, seenSeq, { lat, lng }),
    [act],
  );

  const sendPick = useCallback(
    (screenId: number, seenSeq: number, option: number) => act('guest:pick', screenId, seenSeq, { option }),
    [act],
  );

  /** Tells the server when a guest comes back after being away from the page during a round. */
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= LEFT_PAGE_AFTER_MS) {
        socketRef.current?.timeout(5000).emit('guest:left', {}, () => undefined);
      }
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return { stage, online, offset, join, sendAnswer, sendVote, sendPin, sendPick };
}

/** Asks the phone to stay awake during the game, where the browser allows it. */
export function useKeepAwake(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        const granted = await navigator.wakeLock.request('screen');
        if (cancelled) void granted.release();
        else lock = granted;
      } catch {
        // Refused or low battery. The game carries on regardless.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void request();
    };
    void request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, [enabled]);
}
