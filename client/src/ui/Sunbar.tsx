import { useEffect, useState, type CSSProperties } from 'react';

export interface CountdownInput {
  /** Both in this device's clock, already corrected for its difference from the server. */
  startsAt: number;
  endsAt: number;
  /** Set while paused, when the deadline has no meaning. */
  pausedRemainingMs?: number | null;
}

export interface Countdown {
  seconds: number;
  done: boolean;
  paused: boolean;
  endsAt: number;
  style: CSSProperties;
}

export function formatSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function useCountdown({ startsAt, endsAt, pausedRemainingMs = null }: CountdownInput): Countdown {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);

  const total = Math.max(1, endsAt - startsAt);
  const paused = pausedRemainingMs !== null;
  // Never more than it started with, even if this device's clock has slipped a little.
  const remainingMs = pausedRemainingMs ?? Math.min(total, Math.max(0, endsAt - now));

  // Computed once per deadline, so the running animation isn't restarted by each tick.
  const [motion, setMotion] = useState({ from: 0, ms: 0 });
  useEffect(() => {
    const left = pausedRemainingMs ?? Math.min(total, Math.max(0, endsAt - Date.now()));
    setMotion({ from: (1 - left / total) * 100, ms: pausedRemainingMs === null ? left : 0 });
  }, [endsAt, total, pausedRemainingMs]);

  return {
    seconds: Math.ceil(remainingMs / 1000),
    done: remainingMs === 0,
    paused,
    endsAt,
    style: { '--from': `${motion.from}%`, '--ms': `${motion.ms}ms` } as CSSProperties,
  };
}

/**
 * The one vibrant element. The fill moves with a CSS animation on the graphics
 * card, so typing stays smooth.
 */
export function Sunbar({ countdown, className }: { countdown: Countdown; className?: string }) {
  const { done, paused, endsAt, style } = countdown;
  const classes = ['sunbar', done ? 'done' : '', paused ? 'paused' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes} style={style} aria-hidden="true">
      <div className="sunbar-clip">
        <div className="sunbar-sweep" />
        <div key={endsAt} className="sunbar-cover" />
      </div>
      <div key={`sun-${endsAt}`} className="sunbar-sun-track">
        <div className="sunbar-sun" />
      </div>
    </div>
  );
}
