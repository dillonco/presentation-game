import { z } from 'zod';
import type { CommandReply } from '../../shared/protocol.js';

type StoredAction = { seq: number; reply: CommandReply };

/**
 * Makes repeats harmless. The same number returns the original result and changes
 * nothing, and an older number is ignored, so a delayed retry can't undo a newer edit.
 */
export function actOnce(
  actions: Map<string, StoredAction>,
  key: string,
  seq: number,
  action: () => CommandReply,
): CommandReply {
  const last = actions.get(key);
  if (last && seq === last.seq) return last.reply;
  if (last && seq < last.seq) return { ok: false, code: 'stale_action' };
  const reply = action();
  actions.set(key, { seq, reply });
  return reply;
}

export const actionSchema = z.object({ seq: z.number(), reply: z.any() });

/** The saved state every one-answer round shares. Each round adds its answers under its own key. */
export function oneAnswerState<R extends z.ZodType>(result: R) {
  return z.object({
    results: z.array(z.tuple([z.string(), result])).nullable(),
    leftPage: z.array(z.string()),
    actions: z.array(z.tuple([z.string(), actionSchema])),
  });
}

interface SharedState<R> {
  results: [string, R][] | null;
  leftPage: string[];
  actions: [string, StoredAction][];
}

/**
 * A round where each guest gives one answer, changes it until time runs out, and is scored on
 * it alone: Where was this? and Pick one. No networking and no clock of its own.
 */
export abstract class OneAnswerRound<A, R extends { points: number }> {
  protected readonly guesses: Map<string, A>;
  private results: Map<string, R> | null;
  private readonly leftPage: Set<string>;
  private readonly actions: Map<string, StoredAction>;

  constructor(guesses: [string, A][] = [], state?: SharedState<R>) {
    this.guesses = new Map(guesses);
    this.results = state?.results ? new Map(state.results) : null;
    this.leftPage = new Set(state?.leftPage);
    this.actions = new Map(state?.actions);
  }

  protected abstract score(guess: A): R;
  /** How long the reveal takes to land on the TV. */
  abstract revealMs(): number;

  protected sharedState(): SharedState<R> {
    return {
      results: this.results ? [...this.results] : null,
      leftPage: [...this.leftPage],
      actions: [...this.actions],
    };
  }

  /** The same number returns the first result, and an older one is ignored. */
  act(playerId: string, seq: number, action: () => CommandReply): CommandReply {
    return actOnce(this.actions, playerId, seq, action);
  }

  lastSeq(playerId: string): number {
    return this.actions.get(playerId)?.seq ?? 0;
  }

  guessOf(playerId: string): A | null {
    return this.guesses.get(playerId) ?? null;
  }

  hasGuessed(playerId: string): boolean {
    return this.guesses.has(playerId);
  }

  guessedIds(): string[] {
    return [...this.guesses.keys()];
  }

  removePlayer(playerId: string): void {
    this.leftPage.delete(playerId);
    this.guesses.delete(playerId);
    this.results?.delete(playerId);
  }

  get resolved(): boolean {
    return this.results !== null;
  }

  /** Scores once, so nobody is scored twice after a restart. */
  resolve(): Map<string, R> {
    this.results ??= new Map([...this.guesses].map(([playerId, guess]) => [playerId, this.score(guess)]));
    return this.results;
  }

  resultOf(playerId: string): R | null {
    return this.results?.get(playerId) ?? null;
  }

  allResults(): ReadonlyMap<string, R> {
    return this.results ?? new Map();
  }

  markLeftPage(playerId: string): void {
    this.leftPage.add(playerId);
  }

  hasLeftPage(playerId: string): boolean {
    return this.leftPage.has(playerId);
  }
}
