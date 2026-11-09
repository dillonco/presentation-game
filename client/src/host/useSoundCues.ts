import { useEffect, useRef } from 'react';
import type { HostView } from '../../../shared/protocol.js';
import { CHOICE_REVEAL, PIN_REVEAL, podiumPlan, revealRowTimes } from '../../../shared/reveal.js';
import { CUE_PRIORITY, play, type Cue } from './sound.js';

interface Planned {
  id: string;
  /** In this device's clock. */
  at: number;
  cue: Cue;
}

const TICK_SECONDS = [5, 4, 3, 2, 1];
/** A cue missed by less than this still plays, so a slow frame doesn't swallow it. */
const JUST_MISSED_MS = 400;
/** Moving on this close to a cue plays it, so time's up still sounds when the next screen wins the race. */
const ABOUT_TO_PLAY_MS = 1000;
const JOIN_GAP_MS = 120;

/** Everything this screen will play, in the device's clock. Timed from the server, like the screens. */
export function plannedCues(view: HostView, offset: number): Planned[] {
  const { screen } = view;
  switch (screen.kind) {
    case 'write':
    case 'vote':
    case 'guess':
    case 'pick': {
      if (screen.timer.pausedRemainingMs !== null) return [];
      const end = screen.timer.endsAt - offset;
      return [
        ...TICK_SECONDS.map((seconds) => ({ id: `tick-${seconds}`, at: end - seconds * 1000, cue: 'tick' as const })),
        { id: 'timeUp', at: end, cue: 'timeUp' },
      ];
    }
    case 'reveal': {
      const times = revealRowTimes(screen.rows);
      const index = screen.rows.findIndex((row) => row.real || row.top);
      if (index < 0) return [];
      const start = screen.startedAt - offset;
      return [{ id: 'real', at: Math.min(start + times[index]!, screen.endsAt - offset), cue: 'real' }];
    }
    case 'pinReveal': {
      const start = screen.startedAt - offset;
      const arrives = start + PIN_REVEAL.flyAtMs + PIN_REVEAL.flyMs;
      return [{ id: 'real', at: Math.min(arrives, screen.endsAt - offset), cue: 'real' }];
    }
    case 'pickReveal': {
      const marked = screen.startedAt - offset + CHOICE_REVEAL.answerAtMs;
      return [{ id: 'real', at: Math.min(marked, screen.endsAt - offset), cue: 'real' }];
    }
    case 'final': {
      const plan = podiumPlan([...new Set(screen.podium.map((row) => row.rank))], screen.rows.length);
      const start = screen.startedAt - offset;
      // Everything is up already, so anything still to come lands now.
      const end = screen.shown ? Math.min(Date.now(), screen.endsAt - offset) : screen.endsAt - offset;
      const cues: Planned[] = [];
      if (plan.listTimes.length > 0) cues.push({ id: 'listIn', at: Math.min(start + Math.min(...plan.listTimes), end), cue: 'listIn' });
      for (const rank of [3, 2, 1] as const) {
        const time = plan.medalTimes[rank];
        if (time !== undefined) cues.push({ id: `place${rank}`, at: Math.min(start + time, end), cue: `place${rank}` });
      }
      return cues;
    }
    default:
      return [];
  }
}

function playMostImportant(cues: Planned[]): void {
  if (cues.length === 0) return;
  const top = cues.reduce((best, cue) => (CUE_PRIORITY[cue.cue] > CUE_PRIORITY[best.cue] ? cue : best));
  play(top.cue);
}

interface ScreenState {
  key: number;
  played: Set<string>;
  pending: Map<string, Planned>;
  timers: number[];
}

/**
 * Plays each screen's cues on time. Arriving at a screen part way through, after a refresh,
 * skips what already happened. Skipping to the end plays only the most important cue that was
 * still to come, so a skip doesn't set off everything at once.
 */
export function useSoundCues(view: HostView | null, offset: number): void {
  const state = useRef<ScreenState | null>(null);
  const previous = useRef<HostView | null>(null);
  const lastJoinAt = useRef(0);

  useEffect(() => {
    if (!view) return;
    const now = Date.now();
    const before = previous.current;
    previous.current = view;

    if (before && view.screen.kind === 'lobby' && before.screen.kind === 'lobby' && view.players.length > before.players.length) {
      if (now - lastJoinAt.current > JOIN_GAP_MS) play('join');
      lastJoinAt.current = now;
    }
    if (before && before.screenId !== view.screenId && view.screen.kind === 'title') play('chime');

    let current = state.current;
    const arriving = !current || current.key !== view.screenId;
    if (current) current.timers.forEach((timer) => window.clearTimeout(timer));
    if (current && arriving) {
      playMostImportant([...current.pending.values()].filter((cue) => cue.at - now < ABOUT_TO_PLAY_MS));
    }
    if (!current || arriving) {
      current = { key: view.screenId, played: new Set(), pending: new Map(), timers: [] };
      state.current = current;
    }
    const screen = current;
    const wasPending = new Set(screen.pending.keys());
    screen.pending.clear();
    screen.timers = [];

    const landed: Planned[] = [];
    // Cues due at the same moment, as after a skip, play as one: the most important of them.
    const due = new Map<number, Planned[]>();
    for (const cue of plannedCues(view, offset)) {
      if (screen.played.has(cue.id)) continue;
      if (cue.at <= now) {
        screen.played.add(cue.id);
        // Already happened when this screen arrived, unless only just missed or brought forward by a skip.
        if (wasPending.has(cue.id) || now - cue.at < JUST_MISSED_MS) landed.push(cue);
        continue;
      }
      screen.pending.set(cue.id, cue);
      due.set(cue.at, [...(due.get(cue.at) ?? []), cue]);
    }
    for (const [at, cues] of due) {
      screen.timers.push(
        window.setTimeout(() => {
          for (const cue of cues) {
            screen.played.add(cue.id);
            screen.pending.delete(cue.id);
          }
          playMostImportant(cues);
        }, at - now),
      );
    }
    playMostImportant(landed);
  }, [view, offset]);

  useEffect(
    () => () => {
      state.current?.timers.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );
}
