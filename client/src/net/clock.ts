import type { Socket } from 'socket.io-client';
import type { TimeReply, TimerView } from '../../../shared/protocol.js';

const SAMPLES = 3;

/**
 * How far the server's clock is ahead of this device's, so TV and phones count down
 * together even when a phone's own clock is wrong. Keeps the sample with the shortest
 * round trip, since that one has the least room for error. Null if none got through.
 */
export async function measureClockOffset(socket: Socket): Promise<number | null> {
  let best: number | null = null;
  let shortest = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const sentAt = Date.now();
    try {
      const reply = (await socket.timeout(3000).emitWithAck('time:sync', {})) as TimeReply;
      const roundTrip = Date.now() - sentAt;
      if (reply.ok && roundTrip < shortest) {
        shortest = roundTrip;
        best = reply.now - (sentAt + roundTrip / 2);
      }
    } catch {
      // A lost sample on a weak connection. The others may still get through.
    }
  }
  return best;
}

const RECHECK_MS = 30_000;
/** Smaller changes are just measurement noise, and each change restarts the timer's animation. */
const IGNORE_BELOW_MS = 250;

/** Measures on every connection and every 30 seconds after. Returns a cleanup. */
export function keepClockSynced(socket: Socket, onChange: (offset: number) => void): () => void {
  let current: number | null = null;
  let stopped = false;
  const measure = async () => {
    if (!socket.connected) return;
    const measured = await measureClockOffset(socket);
    if (stopped || measured === null) return;
    if (current === null || Math.abs(measured - current) >= IGNORE_BELOW_MS) {
      current = measured;
      onChange(measured);
    }
  };
  const onConnect = () => void measure();
  socket.on('connect', onConnect);
  const timer = window.setInterval(() => void measure(), RECHECK_MS);
  return () => {
    stopped = true;
    socket.off('connect', onConnect);
    window.clearInterval(timer);
  };
}

export interface LocalTimes {
  startsAt: number;
  endsAt: number;
  pausedRemainingMs: number | null;
}

/** Converts a server-clock timer to this device's clock. */
export function toLocalTimes(timer: TimerView, offset: number): LocalTimes {
  const endsAt = timer.endsAt - offset;
  return { startsAt: endsAt - timer.totalMs, endsAt, pausedRemainingMs: timer.pausedRemainingMs };
}
