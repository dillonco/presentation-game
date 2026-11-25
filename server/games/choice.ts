import { z } from 'zod';
import type { ChoiceRow, CommandReply } from '../../shared/protocol.js';
import { CHOICE_REVEAL } from '../../shared/reveal.js';
import { OneAnswerRound, oneAnswerState } from './one-answer.js';

interface ChoiceConfig {
  image: string;
  question: string;
  /** Already in the order guests see them. */
  options: string[];
  /** Which of `options` is right. */
  answer: number;
  answerMs: number;
  points: number;
}

interface ChoiceResult {
  correct: boolean;
  points: number;
}

const stateSchema = oneAnswerState(z.object({ correct: z.boolean(), points: z.number() })).extend({
  picks: z.array(z.tuple([z.string(), z.number().int().min(0)])),
});

export type ChoiceState = z.infer<typeof stateSchema>;

/** One photo of Pick one. Each guest's guess is the position of an answer. */
export class ChoiceRound extends OneAnswerRound<number, ChoiceResult> {
  constructor(
    readonly config: ChoiceConfig,
    state?: ChoiceState,
  ) {
    super(state?.picks, state);
  }

  static parseState(value: unknown): ChoiceState | null {
    const parsed = stateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  toState(): ChoiceState {
    return { picks: [...this.guesses], ...this.sharedState() };
  }

  /** One current choice per guest. Choosing again replaces it, until time runs out. */
  pick(playerId: string, option: number): CommandReply {
    if (!Number.isInteger(option) || option < 0 || option >= this.config.options.length) {
      return { ok: false, code: 'not_found' };
    }
    this.guesses.set(playerId, option);
    return { ok: true };
  }

  protected score(option: number): ChoiceResult {
    const correct = option === this.config.answer;
    return { correct, points: correct ? this.config.points : 0 };
  }

  revealMs(): number {
    return CHOICE_REVEAL.namesAtMs;
  }

  /** Only sent at the reveal. Counts only guests still in the game. */
  revealRows(present: (playerId: string) => boolean): ChoiceRow[] {
    const counts = this.config.options.map(() => 0);
    for (const [playerId, option] of this.guesses) {
      if (present(playerId)) counts[option] = (counts[option] ?? 0) + 1;
    }
    return this.config.options.map((text, index) => ({
      text,
      count: counts[index]!,
      correct: index === this.config.answer,
    }));
  }
}
