/**
 * When each row of a reveal appears, in milliseconds from the start. Rows arrive least-voted
 * first with the real answer or top caption last. Answers nobody picked pass quickly, so a full
 * room isn't left watching 40 of them one at a time, and the wait lands on the ones people chose.
 */
const NO_VOTES_MS = 700;
const NO_VOTES_TOTAL_MS = 5000;
const VOTED_MS = 1400;
const VOTED_TOTAL_MS = 10_000;
const PAUSE_BEFORE_WINNER_MS = 1800;

export function revealRowTimes(rows: readonly { votes: number; real: boolean; top?: boolean }[]): number[] {
  const quiet = rows.filter((row) => !row.real && row.votes === 0).length;
  const voted = rows.filter((row) => !row.real && row.votes > 0).length;
  const quietStep = quiet > 0 ? Math.min(NO_VOTES_MS, NO_VOTES_TOTAL_MS / quiet) : 0;
  const votedStep = voted > 0 ? Math.min(VOTED_MS, VOTED_TOTAL_MS / voted) : 0;

  const times: number[] = [];
  let at = 0;
  let paused = false;
  for (const [index, row] of rows.entries()) {
    if (index > 0) {
      // One pause, even when several captions tie for the top.
      if ((row.real || row.top) && !paused) {
        at += PAUSE_BEFORE_WINNER_MS;
        paused = true;
      } else {
        at += row.votes === 0 ? quietStep : votedStep;
      }
    }
    times.push(Math.round(at));
  }
  return times;
}

/**
 * The map reveal, in milliseconds from its start. Everyone's pins land on the whole country, the
 * map flies to the real spot, then the closest names arrive one at a time.
 */
export const PIN_REVEAL = {
  flyAtMs: 1500,
  flyMs: 3500,
  namesAtMs: 5200,
  nameStepMs: 500,
  /** How many of the closest get a row on the TV. */
  rows: 5,
  /** How many of those are also named on the map, so 50 pins stay legible. */
  labelled: 3,
} as const;

/** When each row arrives. The list reads closest first, but the closest lands last. */
export function pinNameTimes(pinCount: number): number[] {
  const rows = Math.min(pinCount, PIN_REVEAL.rows);
  return Array.from({ length: rows }, (_, index) => PIN_REVEAL.namesAtMs + (rows - 1 - index) * PIN_REVEAL.nameStepMs);
}

export function pinRevealMs(pinCount: number): number {
  return Math.max(PIN_REVEAL.flyAtMs + PIN_REVEAL.flyMs, ...pinNameTimes(pinCount));
}

/**
 * The Pick one reveal, in milliseconds from its start. How many chose each answer fills in
 * first, so the room sees where everyone went, then a beat later the right one is circled and
 * the names of everyone who got it appear.
 */
export const CHOICE_REVEAL = {
  countsAtMs: 600,
  answerAtMs: 3000,
  namesAtMs: 3600,
  /** Names the TV lists before it says how many more got it. */
  names: 12,
} as const;

const SHOW_BASE_MS = 4000;
const SHOW_PER_CHARACTER_MS = 40;
const SHOW_LONGEST_MS = 10_000;
const SHOW_SHORTEST_MS = 2500;
const SHOW_TOTAL_MS = 120_000;

/**
 * How long one answer stays on the TV before the vote: time to read it and laugh, more for a
 * long one. It goes only by length, so the time can't give away Define it's real answer. In a full room each gets less, so a photo doesn't take ten minutes. The presenter can
 * hold on a good one with P, or set a fixed time in the deck.
 */
export function showcaseMs(text: string, count: number, fixedMs?: number): number {
  if (fixedMs !== undefined) return fixedMs;
  const reading = Math.min(SHOW_LONGEST_MS, SHOW_BASE_MS + Array.from(text).length * SHOW_PER_CHARACTER_MS);
  return Math.max(SHOW_SHORTEST_MS, Math.min(reading, Math.floor(SHOW_TOTAL_MS / Math.max(1, count))));
}

/**
 * The final podium, in milliseconds from its start. Places below the podium fade in from the
 * bottom, then a pause, then 3rd, 2nd and 1st each land, with a longer wait before 1st.
 * A place that nobody holds, such as 2nd when two people tie for 1st, gets no beat.
 */
export const PODIUM = {
  listAtMs: 800,
  listStepMs: 260,
  firstMedalPauseMs: 1800,
  medalGapMs: 2600,
  beforeWinnerMs: 3600,
  /**
   * Phones wait this much longer than the TV, so a phone whose clock estimate is slightly
   * off still never shows a place before the room sees it.
   */
  phoneDelayMs: 500,
  /** Rows on the TV, podium included. */
  rows: 10,
  /** Names a podium card shows before it says how many more share that place. */
  namesPerCard: 3,
} as const;

export type Medal = 1 | 2 | 3;

export interface PodiumPlan {
  /** When each row below the podium appears, in the order they're listed. */
  listTimes: number[];
  /** When each place lands, keyed by rank. Only places someone holds are present. */
  medalTimes: Partial<Record<Medal, number>>;
  /** When everything is up. */
  lastMs: number;
}

export function podiumPlan(medalRanks: readonly number[], listCount: number): PodiumPlan {
  // The bottom row arrives first, so the list builds up towards the podium.
  const listTimes = Array.from(
    { length: listCount },
    (_, index) => PODIUM.listAtMs + (listCount - 1 - index) * PODIUM.listStepMs,
  );
  let at = listCount > 0 ? PODIUM.listAtMs + (listCount - 1) * PODIUM.listStepMs + PODIUM.firstMedalPauseMs : PODIUM.listAtMs;
  const medalTimes: PodiumPlan['medalTimes'] = {};
  let first = true;
  for (const rank of [3, 2, 1] as const) {
    if (!medalRanks.includes(rank)) continue;
    if (!first) at += rank === 1 ? PODIUM.beforeWinnerMs : PODIUM.medalGapMs;
    medalTimes[rank] = at;
    first = false;
  }
  const lastMs = first ? Math.max(0, ...listTimes) : at;
  return { listTimes, medalTimes, lastMs };
}
