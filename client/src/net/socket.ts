import { io, type Socket } from 'socket.io-client';

export function openSocket(room: string, role: 'guest' | 'host'): Socket {
  return io({
    auth: { room, role },
    // Starts on long polling and upgrades to WebSockets, the most reliable order on weak networks.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 400,
    reconnectionDelayMax: 2000,
    randomizationFactor: 0.3,
    timeout: 8000,
  });
}

/**
 * A dead connection can take 45 seconds to notice from heartbeats alone. The browser
 * knows much sooner when signal is lost, so react straight away. Returns a cleanup.
 */
export function reconnectWithNetwork(socket: Socket): () => void {
  const dropConnection = () => {
    socket.io.engine?.close();
  };
  const reconnectNow = () => {
    if (!socket.connected && !socket.active) socket.connect();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnectNow();
  };
  window.addEventListener('offline', dropConnection);
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('offline', dropConnection);
    window.removeEventListener('online', reconnectNow);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

const REPLY_TIMEOUT_MS = 5000;
const RETRY_PAUSE_MS = 400;

function waitForConnection(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once('connect', () => resolve()));
}

/**
 * Keeps sending until the server replies, so nothing is lost in a dropout. Every
 * message sent this way must be safe to repeat, and `stillWanted` lets the caller
 * stop once the result no longer matters.
 */
export async function sendUntilReplied<Reply>(
  socket: Socket,
  event: string,
  payload: unknown,
  stillWanted: () => boolean = () => true,
): Promise<Reply | null> {
  while (stillWanted()) {
    await waitForConnection(socket);
    if (!stillWanted()) return null;
    try {
      return (await socket.timeout(REPLY_TIMEOUT_MS).emitWithAck(event, payload)) as Reply;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
  return null;
}

/** Storage can throw in a private window, so the game still works from memory if it does. */
const memory = new Map<string, string>();

export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key: string, value: string): void {
    memory.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Kept in memory above.
    }
  },
};
