import { z } from 'zod';
import type { ChoiceRow } from '../../shared/protocol.js';
import { actOnce, type ActionResult } from './write-vote.js';

export interface ChoiceConfig {
  image: string;
  question: string;
  /** Already in the order guests see them. */
  options: string[];
  /** Which of `options` is right. */
  answer: number;
  answerMs: number;
  points: number;
}

export interface ChoiceResult {
  correct: boolean;
  points: number;
}

const stateSchema = z.object({
  picks: z.array(z.tuple([z.string(), z.number().int().min(0)])),
  results: z.array(z.tuple([z.string(), z.object({ correct: z.boolean(), points: z.number() })])).nullable(),
  leftPage: z.array(z.string()),
  actions: z.array(z.tuple([z.string(), z.object({ seq: z.number(), reply: z.any() })])),
});

export type ChoiceState = z.infer<typeof stateSchema>;

/** One photo of Pick one, with no networking and no clock of its own. */
export class ChoiceRound {
  private readonly picks = new Map<string, number>();
  private results: Map<string, ChoiceResult> | null = null;
  private readonly leftPage = new Set<string>();
  private readonly actions = new Map<string, { seq: number; reply: ActionResult }>();

  constructor(
    readonly config: ChoiceConfig,
    state?: ChoiceState,
  ) {
    if (!state) return;
    for (const [key, value] of state.picks) this.picks.set(key, value);
    this.results = state.results ? new Map(state.results) : null;
    for (const id of state.leftPage) this.leftPage.add(id);
    for (const [key, value] of state.actions) this.actions.set(key, value);
  }

  static parseState(value: unknown): ChoiceState | null {
    const parsed = stateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  toState(): ChoiceState {
    return {
      picks: [...this.picks],
      results: this.results ? [...this.results] : null,
      leftPage: [...this.leftPage],
      actions: [...this.actions],
    };
  }

  /** The same number returns the first result, and an older one is ignored. */
  act(playerId: string, seq: number, action: () => ActionResult): ActionResult {
    return actOnce(this.actions, playerId, seq, action);
  }

  lastSeq(playerId: string): number {
    return this.actions.get(playerId)?.seq ?? 0;
  }

  /** One current choice per guest. Choosing again replaces it, until time runs out. */
  pick(playerId: string, option: number): ActionResult {
    if (!Number.isInteger(option) || option < 0 || option >= this.config.options.length) {
      return { ok: false, code: 'not_found' };
    }
    this.picks.set(playerId, option);
    return { ok: true };
  }

  pickOf(playerId: string): number | null {
    return this.picks.get(playerId) ?? null;
  }

  hasPick(playerId: string): boolean {
    return this.picks.has(playerId);
  }

  pickedIds(): string[] {
    return [...this.picks.keys()];
  }

  removePlayer(playerId: string): void {
    this.leftPage.delete(playerId);
    this.picks.delete(playerId);
    this.results?.delete(playerId);
  }

  get resolved(): boolean {
    return this.results !== null;
  }

  /** Scores once, so nobody is scored twice after a restart. */
  resolve(): Map<string, ChoiceResult> {
    if (this.results) return this.results;
    const { answer, points } = this.config;
    this.results = new Map(
      [...this.picks].map(([playerId, option]) => {
        const correct = option === answer;
        return [playerId, { correct, points: correct ? points : 0 }];
      }),
    );
    return this.results;
  }

  resultOf(playerId: string): ChoiceResult | null {
    return this.results?.get(playerId) ?? null;
  }

  allResults(): ReadonlyMap<string, ChoiceResult> {
    return this.results ?? new Map();
  }

  /** Only sent at the reveal. Counts only guests still in the game. */
  revealRows(present: (playerId: string) => boolean): ChoiceRow[] {
    const counts = this.config.options.map(() => 0);
    for (const [playerId, option] of this.picks) {
      if (present(playerId)) counts[option] = (counts[option] ?? 0) + 1;
    }
    return this.config.options.map((text, index) => ({
      text,
      count: counts[index]!,
      correct: index === this.config.answer,
    }));
  }

  markLeftPage(playerId: string): void {
    this.leftPage.add(playerId);
  }

  hasLeftPage(playerId: string): boolean {
    return this.leftPage.has(playerId);
  }
}
