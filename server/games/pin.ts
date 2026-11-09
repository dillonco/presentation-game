import { z } from 'zod';
import { distanceKm, pinPoints, type Spot } from '../../shared/geo.js';
import type { RevealPin } from '../../shared/protocol.js';
import { actOnce, type ActionResult } from './write-vote.js';

export interface PinConfig {
  place: Spot & { label: string; image: string };
  guessMs: number;
  maxPoints: number;
  /** The distance at which a pin earns about a third of the points. */
  scaleKm: number;
  allowed: (spot: Spot) => boolean;
}

export interface PinResult {
  km: number;
  points: number;
}

const COORDINATE_DECIMALS = 1e5;
const round = (value: number) => Math.round(value * COORDINATE_DECIMALS) / COORDINATE_DECIMALS;

const spotSchema = z.object({ lat: z.number(), lng: z.number() });

const stateSchema = z.object({
  pins: z.array(z.tuple([z.string(), spotSchema])),
  results: z.array(z.tuple([z.string(), z.object({ km: z.number(), points: z.number() })])).nullable(),
  leftPage: z.array(z.string()),
  actions: z.array(z.tuple([z.string(), z.object({ seq: z.number(), reply: z.any() })])),
});

export type PinState = z.infer<typeof stateSchema>;

/** One photo of Where was this?, with no networking and no clock of its own. */
export class PinRound {
  private readonly pins = new Map<string, Spot>();
  private results: Map<string, PinResult> | null = null;
  private readonly leftPage = new Set<string>();
  private readonly actions = new Map<string, { seq: number; reply: ActionResult }>();

  constructor(
    readonly config: PinConfig,
    state?: PinState,
  ) {
    if (!state) return;
    for (const [key, value] of state.pins) this.pins.set(key, value);
    this.results = state.results ? new Map(state.results) : null;
    for (const id of state.leftPage) this.leftPage.add(id);
    for (const [key, value] of state.actions) this.actions.set(key, value);
  }

  static parseState(value: unknown): PinState | null {
    const parsed = stateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  toState(): PinState {
    return {
      pins: [...this.pins],
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

  /** One current pin per guest. Moving it replaces the old one, and a refused move leaves it. */
  place(playerId: string, lat: number, lng: number): ActionResult {
    const spot = { lat: round(lat), lng: round(lng) };
    if (!this.config.allowed(spot)) return { ok: false, code: 'outside_country' };
    this.pins.set(playerId, spot);
    return { ok: true };
  }

  pinOf(playerId: string): Spot | null {
    return this.pins.get(playerId) ?? null;
  }

  hasPin(playerId: string): boolean {
    return this.pins.has(playerId);
  }

  pinnedIds(): string[] {
    return [...this.pins.keys()];
  }

  removePlayer(playerId: string): void {
    this.leftPage.delete(playerId);
    this.pins.delete(playerId);
    this.results?.delete(playerId);
  }

  get resolved(): boolean {
    return this.results !== null;
  }

  /** Scores once, so nobody is scored twice after a restart. */
  resolve(): Map<string, PinResult> {
    if (this.results) return this.results;
    const { place, scaleKm, maxPoints } = this.config;
    this.results = new Map(
      [...this.pins].map(([playerId, pin]) => {
        const km = distanceKm(pin, place);
        return [playerId, { km, points: pinPoints(km, scaleKm, maxPoints) }];
      }),
    );
    return this.results;
  }

  resultOf(playerId: string): PinResult | null {
    return this.results?.get(playerId) ?? null;
  }

  allResults(): ReadonlyMap<string, PinResult> {
    return this.results ?? new Map();
  }

  /** Closest first. Only sent at the reveal, along with the real spot. */
  revealPins(nameOf: (playerId: string) => string | null): RevealPin[] {
    const pins: RevealPin[] = [];
    for (const [playerId, result] of this.results ?? []) {
      const pin = this.pins.get(playerId);
      const name = nameOf(playerId);
      if (pin && name !== null) pins.push({ id: playerId, name, ...pin, km: result.km, points: result.points });
    }
    return pins.sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1));
  }

  markLeftPage(playerId: string): void {
    this.leftPage.add(playerId);
  }

  hasLeftPage(playerId: string): boolean {
    return this.leftPage.has(playerId);
  }
}
