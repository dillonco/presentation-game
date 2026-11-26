import { z } from 'zod';
import { distanceKm, pinPoints, type Spot } from '../../shared/geo.js';
import type { CommandReply, RevealPin } from '../../shared/protocol.js';
import { pinRevealMs } from '../../shared/reveal.js';
import { OneAnswerRound, oneAnswerState } from './one-answer.js';

interface PinConfig {
  place: Spot & { label: string; image: string };
  guessMs: number;
  maxPoints: number;
  /** The distance at which a pin earns about a third of the points. */
  scaleKm: number;
  allowed: (spot: Spot) => boolean;
}

interface PinResult {
  km: number;
  points: number;
}

const COORDINATE_DECIMALS = 1e5;
const round = (value: number) => Math.round(value * COORDINATE_DECIMALS) / COORDINATE_DECIMALS;

const stateSchema = oneAnswerState(z.object({ km: z.number(), points: z.number() })).extend({
  pins: z.array(z.tuple([z.string(), z.object({ lat: z.number(), lng: z.number() })])),
});

export type PinState = z.infer<typeof stateSchema>;

/** One photo of Where was this? Each guest's guess is a pin. */
export class PinRound extends OneAnswerRound<Spot, PinResult> {
  constructor(
    readonly config: PinConfig,
    state?: PinState,
  ) {
    super(state?.pins, state);
  }

  static parseState(value: unknown): PinState | null {
    const parsed = stateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  toState(): PinState {
    return { pins: [...this.guesses], ...this.sharedState() };
  }

  /** One current pin per guest. Moving it replaces the old one, and a refused move leaves it. */
  place(playerId: string, lat: number, lng: number): CommandReply {
    const spot = { lat: round(lat), lng: round(lng) };
    if (!this.config.allowed(spot)) return { ok: false, code: 'outside_country' };
    this.guesses.set(playerId, spot);
    return { ok: true };
  }

  protected score(pin: Spot): PinResult {
    const km = distanceKm(pin, this.config.place);
    return { km, points: pinPoints(km, this.config.scaleKm, this.config.maxPoints) };
  }

  revealMs(): number {
    return pinRevealMs(this.guesses.size);
  }

  /** Closest first. Only sent at the reveal, along with the real spot. */
  revealPins(nameOf: (playerId: string) => string | null): RevealPin[] {
    const pins: RevealPin[] = [];
    for (const [playerId, result] of this.allResults()) {
      const pin = this.guesses.get(playerId);
      const name = nameOf(playerId);
      if (pin && name !== null) pins.push({ id: playerId, name, ...pin, km: result.km, points: result.points });
    }
    return pins.sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1));
  }
}
