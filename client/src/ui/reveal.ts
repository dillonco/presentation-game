import { useEffect, useState } from 'react';

/**
 * Milliseconds into a timed reveal, ticking ten times a second. Once it's over, or skipped, it's
 * infinite, so everything shows. Timed from the server, so a refreshed screen picks up where it was.
 */
export function useElapsed(startedAt: number, endsAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Date.now() >= endsAt) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= endsAt) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  const current = Math.max(now, Date.now());
  return current >= endsAt ? Number.POSITIVE_INFINITY : current - startedAt;
}

/** False until `endsAt`, then true. A phone waits for the TV this way, so it doesn't spoil the reveal. */
export function useHeldUntil(endsAt: number): boolean {
  const [reached, setReached] = useState(() => Date.now() >= endsAt);
  useEffect(() => {
    const wait = endsAt - Date.now();
    setReached(wait <= 0);
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setReached(true), wait);
    return () => window.clearTimeout(timer);
  }, [endsAt]);
  return reached;
}
