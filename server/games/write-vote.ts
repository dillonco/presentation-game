import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MAX_FLAGGED_TRIES } from '../../shared/constants.js';
import { answerProblem, cleanName, hitsBlocklist } from '../../shared/names.js';
import type { BallotEntry, ErrorCode, RevealRow } from '../../shared/protocol.js';
import { tooSimilar, type Strictness } from './similarity.js';

/** A short wait between flagged tries, on top of the limit on how many there can be. */
export const FLAGGED_WAIT_MS = 2000;
const EXTRA_VOTE_MS_PER_ENTRY = 3000;
const ENTRIES_WITHOUT_EXTRA_TIME = 8;

export interface PointRules {
  /** Define it: finding the real answer. */
  findReal: number;
  /** Define it: each person fooled, up to a maximum so one entry can't run away with the game. */
  perFooled: number;
  fooledMax: number;
  /** Caption this: each vote, up to a maximum. */
  perVote: number;
  voteMax: number;
  /** Caption this: the top caption. Ties all get it. */
  topBonus: number;
}

export const DEFAULT_POINTS: PointRules = {
  findReal: 1000,
  perFooled: 500,
  fooledMax: 1500,
  perVote: 200,
  voteMax: 1500,
  topBonus: 500,
};

export interface RoundConfig {
  game: 'define' | 'caption';
  prompt: string;
  /** Null for Caption this, where there's nothing real to find. */
  realAnswer: string | null;
  writeMs: number;
  voteMs: number;
  /** A fixed time for each answer shown before the vote, instead of by its length. */
  showMs?: number;
  points: PointRules;
  similarity: Strictness;
  blocklist: string[];
}

export type ActionResult = { ok: true } | { ok: false; code: ErrorCode };

interface Entry {
  id: string;
  text: string;
  /** Null for the real answer. */
  authorId: string | null;
  /** Taken off the ballot before the reveal. */
  removed: boolean;
  /** Blanked by the presenter after the reveal. */
  masked: boolean;
}

export interface PlayerResult {
  foundReal: boolean;
  votes: number;
  points: number;
}

const actionSchema = z.object({ seq: z.number(), reply: z.any() });

const stateSchema = z.object({
  seed: z.string(),
  answers: z.array(z.tuple([z.string(), z.string()])),
  flagged: z.array(z.tuple([z.string(), z.object({ count: z.number(), lastAt: z.number() })])),
  entries: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        authorId: z.string().nullable(),
        removed: z.boolean(),
        masked: z.boolean(),
      }),
    )
    .nullable(),
  votes: z.array(z.tuple([z.string(), z.string()])),
  voteCleared: z.array(z.string()),
  results: z
    .array(z.tuple([z.string(), z.object({ foundReal: z.boolean(), votes: z.number(), points: z.number() })]))
    .nullable(),
  leftPage: z.array(z.string()),
  actions: z.array(z.tuple([z.string(), actionSchema])),
});

export type RoundState = z.infer<typeof stateSchema>;

/**
 * Makes repeats harmless. The same number returns the original result and changes
 * nothing, and an older number is ignored, so a delayed retry can't undo a newer edit.
 */
export function actOnce(
  actions: Map<string, { seq: number; reply: ActionResult }>,
  key: string,
  seq: number,
  action: () => ActionResult,
): ActionResult {
  const last = actions.get(key);
  if (last && seq === last.seq) return last.reply;
  if (last && seq < last.seq) return { ok: false, code: 'stale_action' };
  const reply = action();
  actions.set(key, { seq, reply });
  return reply;
}

function randomId(): string {
  return randomBytes(9).toString('base64url');
}

function orderKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('base64url');
}

/**
 * One write-then-vote round, with no networking and no clock of its own, so each
 * rule can be tested directly. Define it and Caption this differ only in their config.
 */
export class WriteVoteRound {
  private readonly seed: string;
  private readonly answers = new Map<string, string>();
  private readonly flagged = new Map<string, { count: number; lastAt: number }>();
  private entries: Entry[] | null = null;
  private readonly votes = new Map<string, string>();
  private readonly voteCleared = new Set<string>();
  private results: Map<string, PlayerResult> | null = null;
  private readonly leftPage = new Set<string>();
  private readonly actions = new Map<string, { seq: number; reply: ActionResult }>();

  constructor(
    readonly config: RoundConfig,
    state?: RoundState,
  ) {
    this.seed = state?.seed ?? randomBytes(16).toString('base64url');
    if (!state) return;
    for (const [key, value] of state.answers) this.answers.set(key, value);
    for (const [key, value] of state.flagged) this.flagged.set(key, value);
    this.entries = state.entries;
    for (const [key, value] of state.votes) this.votes.set(key, value);
    for (const id of state.voteCleared) this.voteCleared.add(id);
    this.results = state.results ? new Map(state.results) : null;
    for (const id of state.leftPage) this.leftPage.add(id);
    for (const [key, value] of state.actions) this.actions.set(key, value);
  }

  static parseState(value: unknown): RoundState | null {
    const parsed = stateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  toState(): RoundState {
    return {
      seed: this.seed,
      answers: [...this.answers],
      flagged: [...this.flagged],
      entries: this.entries,
      votes: [...this.votes],
      voteCleared: [...this.voteCleared],
      results: this.results ? [...this.results] : null,
      leftPage: [...this.leftPage],
      actions: [...this.actions],
    };
  }

  act(stage: 'write' | 'vote', playerId: string, seq: number, action: () => ActionResult): ActionResult {
    return actOnce(this.actions, `${stage}:${playerId}`, seq, action);
  }

  lastSeq(stage: 'write' | 'vote', playerId: string): number {
    return this.actions.get(`${stage}:${playerId}`)?.seq ?? 0;
  }

  // ---------- Writing ----------

  answerOf(playerId: string): string | null {
    return this.answers.get(playerId) ?? null;
  }

  triesLeft(playerId: string): number {
    return Math.max(0, MAX_FLAGGED_TRIES - (this.flagged.get(playerId)?.count ?? 0));
  }

  /** Answers are checked one at a time, so two identical answers sent together can't both pass. */
  submitAnswer(playerId: string, raw: string, now: number): ActionResult {
    const text = cleanName(raw);
    const problem = answerProblem(text);
    if (problem === 'empty') return { ok: false, code: 'answer_empty' };
    if (problem === 'too_long') return { ok: false, code: 'answer_too_long' };
    if (hitsBlocklist(text, this.config.blocklist)) return { ok: false, code: 'answer_blocked' };
    if (this.answers.get(playerId) === text) return { ok: true };

    const flags = this.flagged.get(playerId) ?? { count: 0, lastAt: Number.NEGATIVE_INFINITY };
    if (flags.count >= MAX_FLAGGED_TRIES) return { ok: false, code: 'no_more_tries' };
    if (now - flags.lastAt < FLAGGED_WAIT_MS) return { ok: false, code: 'too_soon' };

    if (this.matchesAnother(playerId, text)) {
      this.flagged.set(playerId, { count: flags.count + 1, lastAt: now });
      return { ok: false, code: 'too_similar' };
    }
    // Replaces the earlier version only now, so a flagged edit leaves it in place.
    this.answers.set(playerId, text);
    return { ok: true };
  }

  private matchesAnother(playerId: string, text: string): boolean {
    const { realAnswer, similarity } = this.config;
    if (realAnswer !== null && tooSimilar(text, realAnswer, similarity)) return true;
    for (const [authorId, other] of this.answers) {
      if (authorId !== playerId && tooSimilar(text, other, similarity)) return true;
    }
    return false;
  }

  /** Someone out of tries can't write any more, so the round shouldn't wait for them. */
  doneWriting(playerId: string): boolean {
    return this.answers.has(playerId) || this.triesLeft(playerId) === 0;
  }

  writerIds(): string[] {
    return [...this.answers.keys()];
  }

  // ---------- Voting ----------

  startVote(): void {
    if (this.entries) return;
    const entries: Entry[] = [...this.answers].map(([authorId, text]) => ({
      id: randomId(),
      text,
      authorId,
      removed: false,
      masked: false,
    }));
    if (this.config.realAnswer !== null) {
      entries.push({ id: randomId(), text: this.config.realAnswer, authorId: null, removed: false, masked: false });
    }
    this.entries = entries;
  }

  private get liveEntries(): Entry[] {
    return (this.entries ?? []).filter((entry) => !entry.removed);
  }

  /** Whether there's anything to choose between. If not, the round goes straight to the reveal. */
  get hasContest(): boolean {
    const written = this.liveEntries.filter((entry) => entry.authorId !== null).length;
    return this.config.realAnswer !== null ? written >= 1 : written >= 2;
  }

  /** Voting gets a little longer when there are many entries to read. */
  voteMs(): number {
    const extra = Math.max(0, this.liveEntries.length - ENTRIES_WITHOUT_EXTRA_TIME);
    return this.config.voteMs + extra * EXTRA_VOTE_MS_PER_ENTRY;
  }

  /** The TV's list, in one shuffled order. */
  allEntries(): BallotEntry[] {
    return this.liveEntries
      .map((entry) => ({ entry, key: orderKey(this.seed, 'tv', entry.id) }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(({ entry }) => ({ id: entry.id, text: entry.text }));
  }

  /** Leaves out the guest's own entry, in an order of its own but stable across reconnects. */
  ballotFor(playerId: string): BallotEntry[] {
    return this.liveEntries
      .filter((entry) => entry.authorId !== playerId)
      .map((entry) => ({ entry, key: orderKey(this.seed, playerId, entry.id) }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(({ entry }) => ({ id: entry.id, text: entry.text }));
  }

  vote(playerId: string, entryId: string): ActionResult {
    const entry = this.liveEntries.find((candidate) => candidate.id === entryId);
    if (!entry) return { ok: false, code: 'not_found' };
    if (entry.authorId === playerId) return { ok: false, code: 'own_entry' };
    // One current vote per guest. A change replaces the old one and never adds to it.
    this.votes.set(playerId, entryId);
    this.voteCleared.delete(playerId);
    return { ok: true };
  }

  voteOf(playerId: string): string | null {
    return this.votes.get(playerId) ?? null;
  }

  voteWasCleared(playerId: string): boolean {
    return this.voteCleared.has(playerId);
  }

  doneVoting(playerId: string): boolean {
    return this.votes.has(playerId) || this.ballotFor(playerId).length === 0;
  }

  voterIds(): string[] {
    return [...this.votes.keys()];
  }

  /** Hides an entry from everyone. Anyone who voted for it gets to vote again. */
  hide(entryId: string): ActionResult {
    const entry = this.entries?.find((candidate) => candidate.id === entryId);
    if (!entry || entry.removed) return { ok: false, code: 'not_found' };
    if (entry.authorId === null) return { ok: false, code: 'cannot_hide' };
    if (this.results) {
      entry.masked = true;
    } else {
      this.removeEntry(entry);
    }
    return { ok: true };
  }

  private removeEntry(entry: Entry): void {
    entry.removed = true;
    for (const [voterId, entryId] of this.votes) {
      if (entryId === entry.id) {
        this.votes.delete(voterId);
        this.voteCleared.add(voterId);
      }
    }
  }

  /** Before the reveal, a removed player's entry and vote both disappear. */
  removePlayer(playerId: string): void {
    this.flagged.delete(playerId);
    this.leftPage.delete(playerId);
    if (this.results) return;
    this.answers.delete(playerId);
    this.votes.delete(playerId);
    this.voteCleared.delete(playerId);
    for (const entry of this.entries ?? []) {
      if (entry.authorId === playerId) this.removeEntry(entry);
    }
  }

  // ---------- Results ----------

  get resolved(): boolean {
    return this.results !== null;
  }

  /** Scores once. Returns each guest's result, and nobody is scored twice after a restart. */
  resolve(): Map<string, PlayerResult> {
    if (this.results) return this.results;
    this.startVote();
    this.results = scoreRound(this.config, this.liveEntries, this.votes);
    return this.results;
  }

  /** Caption this: the most votes, or tied for them. Nobody wins with no votes at all. */
  isTop(playerId: string): boolean {
    if (this.config.realAnswer !== null || !this.results) return false;
    const votes = this.results.get(playerId)?.votes ?? 0;
    return votes > 0 && votes === Math.max(...[...this.results.values()].map((result) => result.votes));
  }

  resultOf(playerId: string): PlayerResult {
    return this.results?.get(playerId) ?? { foundReal: false, votes: 0, points: 0 };
  }

  allResults(): Map<string, PlayerResult> {
    return this.results ?? new Map();
  }

  /** Builds from least-voted to most-voted, with the real answer last. */
  revealRows(nameOf: (playerId: string) => string | null): RevealRow[] {
    const tally = new Map<string, number>();
    for (const entryId of this.votes.values()) tally.set(entryId, (tally.get(entryId) ?? 0) + 1);
    const most = Math.max(0, ...tally.values());
    const rows = this.liveEntries.map((entry) => {
      const votes = tally.get(entry.id) ?? 0;
      return {
        id: entry.id,
        text: entry.masked ? '' : entry.text,
        real: entry.authorId === null,
        top: this.config.realAnswer === null && votes > 0 && votes === most,
        author: entry.authorId === null ? null : nameOf(entry.authorId),
        votes,
        masked: entry.masked,
      };
    });
    return rows.sort(
      (a, b) => Number(a.real) - Number(b.real) || a.votes - b.votes || (a.id < b.id ? -1 : 1),
    );
  }

  // ---------- Left the page ----------

  markLeftPage(playerId: string): void {
    this.leftPage.add(playerId);
  }

  hasLeftPage(playerId: string): boolean {
    return this.leftPage.has(playerId);
  }
}

/** Kept apart from the round so the points can be tested as plain numbers. */
export function scoreRound(
  config: Pick<RoundConfig, 'points' | 'realAnswer'>,
  entries: readonly Pick<Entry, 'id' | 'authorId'>[],
  votes: ReadonlyMap<string, string>,
): Map<string, PlayerResult> {
  const { points, realAnswer } = config;
  const results = new Map<string, PlayerResult>();
  const resultFor = (playerId: string): PlayerResult => {
    let result = results.get(playerId);
    if (!result) {
      result = { foundReal: false, votes: 0, points: 0 };
      results.set(playerId, result);
    }
    return result;
  };

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const [voterId, entryId] of votes) {
    const entry = byId.get(entryId);
    if (!entry) continue;
    if (entry.authorId === null) {
      const voter = resultFor(voterId);
      voter.foundReal = true;
      voter.points += points.findReal;
    } else if (entry.authorId !== voterId) {
      resultFor(entry.authorId).votes += 1;
    }
  }

  const isCaption = realAnswer === null;
  const most = Math.max(0, ...[...results.values()].map((result) => result.votes));
  for (const result of results.values()) {
    if (result.votes === 0) continue;
    if (isCaption) {
      result.points += Math.min(points.voteMax, result.votes * points.perVote);
      if (result.votes === most) result.points += points.topBonus;
    } else {
      result.points += Math.min(points.fooledMax, result.votes * points.perFooled);
    }
  }
  return results;
}
