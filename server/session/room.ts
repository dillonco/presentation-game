import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DEADLINE_GRACE_MS,
  MAX_PENDING_REJOINS,
  MAX_PLAYERS,
  REJOIN_REQUEST_TTL_MS,
} from '../../shared/constants.js';
import { findCountry, type Country } from '../../shared/countries.js';
import { countryScaleKm } from '../../shared/geo.js';
import { cleanName, hitsBlocklist, nameKey, textProblem } from '../../shared/names.js';
import { PODIUM, podiumPlan, showcaseMs, type PodiumPlan } from '../../shared/reveal.js';
import type {
  CommandReply,
  ErrorCode,
  GameType,
  GuestScreen,
  GuestView,
  HostScreen,
  HostView,
  JoinState,
  KickReason,
  RejoinResult,
  RoundInfo,
  StandingRow,
  TimerView,
} from '../../shared/protocol.js';
import { ChoiceRound, type ChoiceState } from '../games/choice.js';
import { PinRound, type PinState } from '../games/pin.js';
import type { Strictness } from '../games/similarity.js';
import { DEFAULT_POINTS, WriteVoteRound, type RoundState } from '../games/write-vote.js';
import { randomId } from '../ids.js';
import { spotAllowed } from '../outlines.js';
import { TokenBucket } from './rate-limit.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

const DEFAULT_WRITE_MS: Record<'define' | 'caption', number> = { define: 60_000, caption: 75_000 };
const DEFAULT_VOTE_MS = 45_000;
const DEFAULT_GUESS_MS = 45_000;
const DEFAULT_PIN_POINTS = 1000;
const DEFAULT_ANSWER_MS = 30_000;
const DEFAULT_CHOICE_POINTS = 1000;
const DEFAULT_COUNTRY = 'Japan';
/**
 * Caption this only needs to stop copies. Jokes often share an opening, so "Me when I see the
 * toilet" and "Me when I see the vending machine" are both fine, though they'd be too close as
 * definitions of one word.
 */
const CAPTION_SIMILARITY: Record<Strictness, Strictness> = { strict: 'normal', normal: 'loose', loose: 'loose' };
const ADD_TIME_MS = 15_000;
/** Once every connected guest is done, this much is left so they can still change their minds. */
const FINAL_STRETCH_MS = 5000;
/** A brief dropout shouldn't shorten a round, so a guest still counts for this long. */
const OFFLINE_GRACE_MS = 10_000;
const REVEAL_PAUSE_MS = 1500;
const LEADERBOARD_ROWS = PODIUM.rows;

const settingsSchema = z
  .object({
    writeMs: z.number().int().positive().optional(),
    voteMs: z.number().int().positive().optional(),
    showMs: z.number().int().positive().optional(),
    points: z
      .object({
        findReal: z.number().int().min(0),
        perFooled: z.number().int().min(0),
        fooledMax: z.number().int().min(0),
        perVote: z.number().int().min(0),
        voteMax: z.number().int().min(0),
        topBonus: z.number().int().min(0),
      })
      .partial()
      .optional(),
  })
  .optional();

const extras = z.array(z.string()).optional();

const setupSchema = z.object({
  title: z.string(),
  accent: z.object({ light: z.string(), dark: z.string() }).optional(),
  country: z.string().optional(),
  blocklist: z.array(z.string()).optional(),
  similarity: z.enum(['loose', 'normal', 'strict']).optional(),
  showLeftPage: z.boolean().optional(),
  tips: z
    .array(
      z.object({
        heading: z.string(),
        text: z.string(),
        places: z.array(z.object({ name: z.string(), url: z.string(), lat: z.number(), lng: z.number() })),
        image: z.string().nullable(),
      }),
    )
    .optional(),
  games: z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('define'),
        settings: settingsSchema,
        items: z.array(
          z.object({
            word: z.string(),
            definition: z.string(),
            clip: z.object({ video: z.string(), start: z.number(), end: z.number() }).optional(),
          }),
        ),
      }),
      z.object({
        type: z.literal('geo'),
        settings: z
          .object({ guessMs: z.number().int().positive().optional(), maxPoints: z.number().int().min(0).optional() })
          .optional(),
        items: z.array(z.object({ image: z.string(), label: z.string(), lat: z.number(), lng: z.number(), extras })),
      }),
      z.object({
        type: z.literal('caption'),
        settings: settingsSchema,
        items: z.array(z.object({ image: z.string(), extras })),
      }),
      z.object({
        type: z.literal('choice'),
        settings: z
          .object({ answerMs: z.number().int().positive().optional(), points: z.number().int().min(0).optional() })
          .optional(),
        items: z.array(
          z.object({
            image: z.string(),
            question: z.string(),
            /** Already shuffled, so the order is the same after a restart. */
            options: z.array(z.string()).min(2),
            answer: z.number().int().min(0),
            extras,
          }),
        ),
      }),
    ]),
  ),
});

export type RoomSetup = z.infer<typeof setupSchema>;

type Step =
  | { kind: 'lobby' }
  | { kind: 'title'; gameNumber: number; game: GameType }
  | { kind: 'round'; stage: 'write' | 'show' | 'vote' | 'reveal'; round: WriteVoteRound; info: RoundInfo }
  | { kind: 'pin'; stage: 'guess' | 'reveal'; round: PinRound; info: RoundInfo }
  | { kind: 'choice'; stage: 'pick' | 'reveal'; round: ChoiceRound; info: RoundInfo }
  /** More photos from the same moment, once the round's result is in. Only when the deck has some. */
  | { kind: 'gallery'; info: RoundInfo; images: string[]; place: string | null }
  | { kind: 'standings'; gameNumber: number; game: GameType }
  | { kind: 'final' }
  /** Tips after the podium. Only when the deck has some. */
  | { kind: 'tips' };

type RoundStep = Extract<Step, { round: unknown }>;
type AnyRound = RoundStep['round'];
/** The stages that take guests' input, and the round each one belongs to. */
type RoundAt = { write: WriteVoteRound; vote: WriteVoteRound; guess: PinRound; pick: ChoiceRound };
const TIMED_STAGES: ReadonlySet<string> = new Set<keyof RoundAt>(['write', 'vote', 'guess', 'pick']);

/** Saved round states, handed out in play order as the night is laid out again. */
interface SavedRounds {
  rounds: RoundState[];
  pinRounds: PinState[];
  choiceRounds: ChoiceState[];
}

function mapAreaOf(setup: RoomSetup): Country {
  return findCountry(setup.country ?? DEFAULT_COUNTRY) ?? findCountry(DEFAULT_COUNTRY)!;
}

/** Lays the night out as one straight line of steps, so moving on is always just the next one. */
function buildProgram(setup: RoomSetup, saved?: SavedRounds): Step[] {
  const steps: Step[] = [{ kind: 'lobby' }];
  const country = setup.country ?? DEFAULT_COUNTRY;
  const similarity = setup.similarity ?? 'normal';
  setup.games.forEach((game, gameIndex) => {
    if (game.items.length === 0) return;
    const gameNumber = gameIndex + 1;
    const info = (index: number, prompt: string, image: string | null): RoundInfo => ({
      game: game.type,
      gameNumber,
      number: index + 1,
      count: game.items.length,
      prompt,
      image,
    });
    const gallery = (roundInfo: RoundInfo, images: string[] = [], place: string | null = null) => {
      if (images.length > 0) steps.push({ kind: 'gallery', info: roundInfo, images, place });
    };
    steps.push({ kind: 'title', gameNumber, game: game.type });

    if (game.type === 'choice') {
      game.items.forEach((item, index) => {
        const round = new ChoiceRound(
          {
            image: item.image,
            question: item.question,
            options: item.options,
            answer: item.answer,
            answerMs: game.settings?.answerMs ?? DEFAULT_ANSWER_MS,
            points: game.settings?.points ?? DEFAULT_CHOICE_POINTS,
          },
          saved?.choiceRounds.shift(),
        );
        const roundInfo = info(index, item.question, item.image);
        for (const stage of ['pick', 'reveal'] as const) steps.push({ kind: 'choice', stage, round, info: roundInfo });
        gallery(roundInfo, item.extras);
      });
    } else if (game.type === 'geo') {
      const scaleKm = countryScaleKm(mapAreaOf(setup));
      game.items.forEach((item, index) => {
        const round = new PinRound(
          {
            place: item,
            guessMs: game.settings?.guessMs ?? DEFAULT_GUESS_MS,
            maxPoints: game.settings?.maxPoints ?? DEFAULT_PIN_POINTS,
            scaleKm,
            allowed: (spot) => spotAllowed(country, spot),
          },
          saved?.pinRounds.shift(),
        );
        const roundInfo = info(index, '', item.image);
        for (const stage of ['guess', 'reveal'] as const) steps.push({ kind: 'pin', stage, round, info: roundInfo });
        gallery(roundInfo, item.extras, item.label);
      });
    } else {
      // Both games are the same round, told apart only by what's on the ballot and how it scores.
      const rounds =
        game.type === 'define'
          ? game.items.map((item, index) => ({
              info: { ...info(index, item.word, null), ...(item.clip ? { clip: item.clip } : {}) },
              realAnswer: item.definition,
              similarity,
              extras: undefined,
            }))
          : game.items.map((item, index) => ({
              info: info(index, '', item.image),
              realAnswer: null,
              similarity: CAPTION_SIMILARITY[similarity],
              extras: item.extras,
            }));
      for (const entry of rounds) {
        const round = new WriteVoteRound(
          {
            game: game.type,
            prompt: entry.info.prompt,
            realAnswer: entry.realAnswer,
            writeMs: game.settings?.writeMs ?? DEFAULT_WRITE_MS[game.type],
            voteMs: game.settings?.voteMs ?? DEFAULT_VOTE_MS,
            showMs: game.settings?.showMs,
            points: { ...DEFAULT_POINTS, ...game.settings?.points },
            similarity: entry.similarity,
            blocklist: setup.blocklist ?? [],
          },
          saved?.rounds.shift(),
        );
        // The answers are the fun, so the room reads each one before anything gets voted on.
        for (const stage of ['write', 'show', 'vote', 'reveal'] as const) {
          steps.push({ kind: 'round', stage, round, info: entry.info });
        }
        gallery(entry.info, entry.extras);
      }
    }
    steps.push({ kind: 'standings', gameNumber, game: game.type });
  });
  steps.push({ kind: 'final' });
  if ((setup.tips ?? []).length > 0) steps.push({ kind: 'tips' });
  return steps;
}

interface Player {
  id: string;
  name: string;
  key: string;
  tokenHash: string;
  joinedAt: number;
  score: number;
  connections: number;
  offlineSince: number | null;
}

/** After a burst, how often a new rejoin request may reach the TV. */
const REJOIN_SPACING_SECONDS = 10;

interface RejoinRequest {
  id: string;
  playerId: string;
  tokenHash: string;
  expiresAt: number;
}

interface StageTimer extends TimerView {
  /** The drop to a final few seconds happens once, and adding time turns it off. */
  stretchDone: boolean;
}

type JoinOutcome =
  | { kind: 'joined'; playerId: string }
  | { kind: 'pending'; created: boolean; closed?: ClosedRequest[] }
  | { kind: 'refused'; code: ErrorCode };

type TokenLookup =
  | { kind: 'player'; playerId: string }
  | { kind: 'pending' }
  | { kind: 'revoked'; reason: KickReason }
  | { kind: 'unknown' };

type TickOutcome = 'none' | 'changed' | 'stage';

export interface ClosedRequest {
  tokenHash: string;
  result: RejoinResult;
}

const snapshotSchema = z.object({
  schema: z.literal(3),
  id: z.string(),
  setup: setupSchema,
  screenIndex: z.number().int().min(0),
  joinLocked: z.boolean(),
  version: z.number().int().min(0),
  createdAt: z.number(),
  updatedAt: z.number(),
  players: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      key: z.string(),
      tokenHash: z.string(),
      joinedAt: z.number(),
      score: z.number(),
    }),
  ),
  revoked: z.array(z.tuple([z.string(), z.enum(['removed', 'superseded'])])),
  rounds: z.array(z.unknown()),
  pinRounds: z.array(z.unknown()),
  /** Left out by games saved before Pick one existed. */
  choiceRounds: z.array(z.unknown()).optional(),
});

type RoomSnapshot = z.infer<typeof snapshotSchema>;

const TOO_LATE: CommandReply = { ok: false, code: 'too_late' };

/** Every state parsed, or null if any is damaged. */
function parseAll<S>(values: unknown[], parse: (value: unknown) => S | null): S[] | null {
  const states = values.map(parse);
  return states.every((state) => state !== null) ? (states as S[]) : null;
}

/**
 * All the rules for one game night, with no networking inside, so each rule can
 * be tested directly. The server's socket layer turns these results into messages.
 */
export class Room {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  updatedAt: number;
  joinLocked = false;
  version = 0;

  private readonly setup: RoomSetup;
  private readonly steps: Step[];
  private readonly blocklist: string[];
  private screenIndex = 0;
  private timer: StageTimer | null = null;
  private revealStartedAt = 0;
  private revealEndsAt = 0;
  private revealLastRowAt = 0;
  /** The presenter skipped to the end of the podium, or the server restarted during it. */
  private podiumShown = false;
  /** Fixed when the showing starts, so removing an answer can't make another get skipped. */
  private showOrder: string[] = [];
  private showIndex = 0;
  private readonly players = new Map<string, Player>();
  private readonly playerByToken = new Map<string, string>();
  private readonly playerByKey = new Map<string, string>();
  private readonly revoked = new Map<string, KickReason>();
  private readonly requests = new Map<string, RejoinRequest>();
  /**
   * New rejoin requests across the room: enough for a few phones coming back at once, and slow
   * enough that nobody can flood the TV with prompts. Not saved, so a restart refills it.
   */
  private rejoinBucket: TokenBucket | null = null;

  constructor(id: string, setup: RoomSetup, now: number, saved?: SavedRounds) {
    this.id = id;
    this.setup = setup;
    this.title = setup.title;
    this.steps = buildProgram(setup, saved);
    this.blocklist = setup.blocklist ?? [];
    this.createdAt = now;
    this.updatedAt = now;
  }

  get finished(): boolean {
    return this.step.kind === 'final' || this.step.kind === 'tips';
  }

  /** The photos this game may still show, so deleting a deck doesn't pull them away mid-game. */
  imageIds(): string[] {
    return [
      ...this.setup.games.flatMap((game) =>
        game.type === 'define' ? [] : game.items.flatMap((item) => [item.image, ...(item.extras ?? [])]),
      ),
      ...(this.setup.tips ?? []).flatMap((tip) => (tip.image ? [tip.image] : [])),
    ];
  }

  private get step(): Step {
    return this.steps[this.screenIndex]!;
  }

  /** The step on screen when it belongs to a round, for what every game shares. */
  private get roundStep(): RoundStep | null {
    const { step } = this;
    return 'round' in step ? step : null;
  }

  /** Each round once, in the order they're played. Every round has exactly one reveal. */
  private roundsOf<T extends AnyRound>(type: new (...args: any[]) => T): T[] {
    return this.steps.flatMap((step) =>
      'round' in step && step.stage === 'reveal' && step.round instanceof type ? [step.round] : [],
    );
  }

  /** The country tonight's map game is in, if there is one. */
  private get mapArea(): Country | null {
    return this.steps.some((step) => step.kind === 'pin') ? mapAreaOf(this.setup) : null;
  }

  get screenId(): number {
    return this.screenIndex;
  }

  get playerCount(): number {
    return this.players.size;
  }

  get playerIds(): string[] {
    return [...this.players.keys()];
  }

  get joinState(): JoinState {
    if (this.joinLocked) return 'locked';
    return this.players.size >= MAX_PLAYERS ? 'full' : 'open';
  }

  get hasPendingRequests(): boolean {
    return this.requests.size > 0;
  }

  get hasRunningTimer(): boolean {
    return this.timer !== null && this.timer.pausedRemainingMs === null;
  }

  lookupToken(tokenHash: string): TokenLookup {
    const reason = this.revoked.get(tokenHash);
    if (reason) return { kind: 'revoked', reason };
    const playerId = this.playerByToken.get(tokenHash);
    if (playerId) return { kind: 'player', playerId };
    for (const request of this.requests.values()) {
      if (request.tokenHash === tokenHash) return { kind: 'pending' };
    }
    return { kind: 'unknown' };
  }

  /**
   * Safe to repeat: resending the same token returns the same player, so a lost
   * reply on a bad connection can never create a second one.
   */
  join(tokenHash: string, rawName: string, now: number): JoinOutcome {
    const known = this.lookupToken(tokenHash);
    if (known.kind === 'revoked') return { kind: 'refused', code: known.reason };
    if (known.kind === 'player') return { kind: 'joined', playerId: known.playerId };
    if (known.kind === 'pending') return { kind: 'pending', created: false };

    const name = cleanName(rawName);
    const problem = textProblem(name);
    if (problem === 'empty') return { kind: 'refused', code: 'name_empty' };
    if (problem === 'too_long') return { kind: 'refused', code: 'name_too_long' };
    if (hitsBlocklist(name, this.blocklist)) return { kind: 'refused', code: 'name_blocked' };

    const key = nameKey(name);
    const sameName = this.players.get(this.playerByKey.get(key) ?? '');
    if (sameName) {
      if (sameName.connections > 0) return { kind: 'refused', code: 'name_taken' };
      return this.requestRejoin(sameName, tokenHash, now);
    }

    if (this.joinLocked) return { kind: 'refused', code: 'join_locked' };
    if (this.players.size >= MAX_PLAYERS) return { kind: 'refused', code: 'room_full' };

    const player: Player = {
      id: randomId(9),
      name,
      key,
      tokenHash,
      joinedAt: now,
      score: 0,
      connections: 0,
      offlineSince: now,
    };
    this.players.set(player.id, player);
    this.playerByToken.set(tokenHash, player.id);
    this.playerByKey.set(key, player.id);
    this.touch(now);
    return { kind: 'joined', playerId: player.id };
  }

  private requestRejoin(player: Player, tokenHash: string, now: number): JoinOutcome {
    this.rejoinBucket ??= new TokenBucket(MAX_PENDING_REJOINS, 1 / REJOIN_SPACING_SECONDS, now);
    if (!this.rejoinBucket.take(now)) return { kind: 'refused', code: 'rejoin_busy' };
    // A newer request for the same player replaces the older one, and once the TV holds as many
    // as it shows, the oldest makes way. Either way, a stranger who asks first can't keep the
    // real player's new phone from asking.
    const closed = this.closeRequests((request) => request.playerId === player.id, 'expired');
    while (this.requests.size >= MAX_PENDING_REJOINS) {
      const oldest = this.requests.values().next().value!;
      closed.push(...this.closeRequests((request) => request === oldest, 'expired'));
    }
    const id = randomId(9);
    this.requests.set(id, { id, playerId: player.id, tokenHash, expiresAt: now + REJOIN_REQUEST_TTL_MS });
    this.touch(now);
    return closed.length > 0 ? { kind: 'pending', created: true, closed } : { kind: 'pending', created: true };
  }

  /** Drops every request that matches, and says what became of each. */
  private closeRequests(matches: (request: RejoinRequest) => boolean, result: RejoinResult): ClosedRequest[] {
    const closed: ClosedRequest[] = [];
    for (const request of this.requests.values()) {
      if (!matches(request)) continue;
      this.requests.delete(request.id);
      closed.push({ tokenHash: request.tokenHash, result });
    }
    return closed;
  }

  /** Returns any request that this reconnection cancels: the real owner came back. */
  connect(playerId: string, now: number): ClosedRequest[] {
    const player = this.players.get(playerId);
    if (!player) return [];
    player.connections += 1;
    player.offlineSince = null;
    const closed = this.closeRequests((request) => request.playerId === playerId, 'cancelled');
    this.touch(now);
    return closed;
  }

  disconnect(playerId: string, now: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connections = Math.max(0, player.connections - 1);
    if (player.connections === 0) player.offlineSince = now;
    this.touch(now);
  }

  // ---------- Moving through the night ----------

  private isTimedStage(step: Step = this.step): boolean {
    return 'stage' in step && TIMED_STAGES.has(step.stage);
  }

  /** The round whose answers are being shown one at a time, if that's what's on. */
  private get showing(): WriteVoteRound | null {
    const { step } = this;
    return step.kind === 'round' && step.stage === 'show' ? step.round : null;
  }

  /** How long a timed stage runs. */
  private stageMs(step: RoundStep): number {
    if (step.kind === 'pin') return step.round.config.guessMs;
    if (step.kind === 'choice') return step.round.config.answerMs;
    return step.stage === 'write' ? step.round.config.writeMs : step.round.voteMs();
  }

  next(screenId: number, now: number): CommandReply {
    if (screenId !== this.screenIndex) return { ok: false, code: 'stale_screen' };
    if (this.isTimedStage()) return { ok: false, code: 'stage_running' };
    const { step } = this;
    if (this.showing) {
      this.nextCaption(now);
      this.touch(now);
      return { ok: true };
    }
    // While rows are still arriving, a press shows them all. Once they're all up, it moves on.
    const revealing = this.roundStep?.stage === 'reveal' || step.kind === 'final';
    if (revealing && now < this.revealLastRowAt) {
      if (step.kind === 'final') this.podiumShown = true;
      this.revealLastRowAt = now;
      this.revealEndsAt = now;
      this.touch(now);
      return { ok: true };
    }
    if (this.screenIndex >= this.steps.length - 1) return { ok: false, code: 'at_end' };
    // A stray press on an empty lobby would start a game nobody can join, with no way back.
    if (step.kind === 'lobby' && this.players.size === 0) return { ok: false, code: 'no_players' };
    // Joining closes by itself when the first game starts. The presenter can reopen it.
    if (step.kind === 'lobby') this.joinLocked = true;
    this.enterStep(this.screenIndex + 1, now);
    this.touch(now);
    return { ok: true };
  }

  private enterStep(index: number, now: number): void {
    this.screenIndex = index;
    this.timer = null;
    const { step } = this;
    if (step.kind === 'final') {
      this.revealStartedAt = now;
      this.revealLastRowAt = now + this.finalLayout().plan.lastMs;
      this.revealEndsAt = this.revealLastRowAt;
      return;
    }
    if (!('round' in step)) return;
    if (step.stage === 'reveal') return this.startReveal(step.round, now);
    if (step.kind === 'round' && step.stage !== 'write') {
      step.round.startVote();
      // With nothing to compare, the next stage carries it on to the reveal, so an empty round
      // still finishes cleanly.
      if (!step.round.hasContest) return this.enterStep(index + 1, now);
      if (step.stage === 'show') {
        this.showOrder = step.round.allEntries().map((entry) => entry.id);
        this.showIndex = -1;
        return this.nextCaption(now);
      }
    }
    this.startTimer(this.stageMs(step), now);
  }

  /** On to the next answer still in the game. After the last one, everything opens for the vote. */
  private nextCaption(now: number): void {
    const round = this.showing!;
    const live = round.allEntries();
    for (let index = this.showIndex + 1; index < this.showOrder.length; index += 1) {
      const entry = live.find((candidate) => candidate.id === this.showOrder[index]);
      if (entry) {
        this.showIndex = index;
        this.startTimer(showcaseMs(entry.text, live.length, round.config.showMs), now);
        return;
      }
    }
    this.enterStep(this.screenIndex + 1, now);
  }

  /** The answer on screen was hidden or its author removed, so it moves straight on. */
  private leaveRemovedCaption(now: number): void {
    const round = this.showing;
    if (!round) return;
    const current = this.showOrder[this.showIndex];
    if (!round.allEntries().some((entry) => entry.id === current)) this.nextCaption(now);
  }

  private startReveal(round: AnyRound, now: number): void {
    if (!round.resolved) {
      for (const [playerId, result] of round.resolve()) {
        const player = this.players.get(playerId);
        if (player) player.score += result.points;
      }
    }
    this.revealStartedAt = now;
    this.revealLastRowAt = now + round.revealMs();
    // Phones wait a moment longer, so the last row lands on the TV before results appear.
    this.revealEndsAt = this.revealLastRowAt + REVEAL_PAUSE_MS;
  }

  private startTimer(totalMs: number, now: number): void {
    this.timer = { endsAt: now + totalMs, totalMs, pausedRemainingMs: null, stretchDone: false, cutShort: false };
  }

  skipTimer(screenId: number, now: number): CommandReply {
    if (screenId !== this.screenIndex) return { ok: false, code: 'stale_screen' };
    const { timer } = this;
    if (!timer) return { ok: false, code: 'no_timer' };
    // Nothing is being sent while answers are shown, so this goes straight to the vote.
    const alreadyEnded = timer.pausedRemainingMs === null && now >= timer.endsAt;
    if (this.showing || alreadyEnded || this.nobodyToWaitFor(now)) {
      this.enterStep(this.screenIndex + 1, now);
    } else {
      // Time's up, as if the timer had run out. Phones send what's on screen during the grace
      // period, and the next tick moves on. Pressing again skips the wait.
      timer.endsAt = now;
      timer.pausedRemainingMs = null;
      timer.stretchDone = true;
      timer.cutShort = true;
    }
    this.touch(now);
    return { ok: true };
  }

  addTime(screenId: number, now: number): CommandReply {
    if (screenId !== this.screenIndex) return { ok: false, code: 'stale_screen' };
    const { timer } = this;
    if (!timer) return { ok: false, code: 'no_timer' };
    timer.totalMs += ADD_TIME_MS;
    timer.stretchDone = true;
    timer.cutShort = false;
    if (timer.pausedRemainingMs !== null) timer.pausedRemainingMs += ADD_TIME_MS;
    else timer.endsAt = Math.max(timer.endsAt, now) + ADD_TIME_MS;
    this.touch(now);
    return { ok: true };
  }

  setPaused(paused: boolean, now: number): CommandReply {
    const { timer } = this;
    if (!timer) return { ok: false, code: 'no_timer' };
    if (paused === (timer.pausedRemainingMs !== null)) return { ok: true };
    if (paused) {
      timer.pausedRemainingMs = Math.max(0, timer.endsAt - now);
    } else {
      timer.endsAt = now + timer.pausedRemainingMs!;
      timer.pausedRemainingMs = null;
    }
    this.touch(now);
    return { ok: true };
  }

  /** Called often. Ends a stage when its time is up, or shortens it once everyone is done. */
  tick(now: number): TickOutcome {
    const { timer } = this;
    if (!timer || timer.pausedRemainingMs !== null) return 'none';
    if (this.showing) {
      if (now < timer.endsAt) return 'none';
      const screen = this.screenIndex;
      this.nextCaption(now);
      this.touch(now);
      return this.screenIndex === screen ? 'changed' : 'stage';
    }
    if (now >= timer.endsAt + DEADLINE_GRACE_MS) {
      this.enterStep(this.screenIndex + 1, now);
      this.touch(now);
      return 'stage';
    }
    if (!timer.stretchDone && timer.endsAt - now > FINAL_STRETCH_MS && this.everyoneDone(now)) {
      timer.endsAt = now + FINAL_STRETCH_MS;
      timer.stretchDone = true;
      this.touch(now);
      return 'changed';
    }
    return 'none';
  }

  private presentPlayers(now: number): Player[] {
    return [...this.players.values()].filter(
      (player) =>
        player.connections > 0 || (player.offlineSince !== null && now - player.offlineSince < OFFLINE_GRACE_MS),
    );
  }

  private isDone(player: Player): boolean {
    const step = this.roundStep;
    if (!step) return false;
    if (step.kind !== 'round') return step.round.hasGuessed(player.id);
    return step.stage === 'write' ? step.round.doneWriting(player.id) : step.round.doneVoting(player.id);
  }

  private everyoneDone(now: number): boolean {
    const present = this.presentPlayers(now);
    return present.length > 0 && present.every((player) => this.isDone(player));
  }

  /** Nobody could still be sending anything, so there's no reason to hold the room. */
  private nobodyToWaitFor(now: number): boolean {
    return this.presentPlayers(now).every((player) => this.isDone(player));
  }

  private stillOpen(now: number): boolean {
    const { timer } = this;
    return timer !== null && (timer.pausedRemainingMs !== null || now <= timer.endsAt + DEADLINE_GRACE_MS);
  }

  // ---------- Guest actions ----------

  /** Runs a guest's action on the round taking input at `stage`, if that's the screen they sent it from. */
  private guestAction<S extends keyof RoundAt>(
    playerId: string,
    screenId: number,
    stage: S,
    now: number,
    action: (round: RoundAt[S], open: boolean) => CommandReply,
  ): CommandReply {
    const step = this.roundStep;
    if (screenId !== this.screenIndex || step?.stage !== stage) return { ok: false, code: 'too_late' };
    if (!this.players.has(playerId)) return { ok: false, code: 'not_found' };
    const reply = action(step.round as RoundAt[S], this.stillOpen(now));
    this.touch(now);
    return reply;
  }

  submitAnswer(playerId: string, screenId: number, seq: number, text: string, now: number): CommandReply {
    return this.guestAction(playerId, screenId, 'write', now, (round, open) =>
      round.act('write', playerId, seq, () => (open ? round.submitAnswer(playerId, text, now) : TOO_LATE)),
    );
  }

  submitVote(playerId: string, screenId: number, seq: number, entryId: string, now: number): CommandReply {
    return this.guestAction(playerId, screenId, 'vote', now, (round, open) =>
      round.act('vote', playerId, seq, () => (open ? round.vote(playerId, entryId) : TOO_LATE)),
    );
  }

  submitPin(playerId: string, screenId: number, seq: number, lat: number, lng: number, now: number): CommandReply {
    return this.guestAction(playerId, screenId, 'guess', now, (round, open) =>
      round.act(playerId, seq, () => (open ? round.place(playerId, lat, lng) : TOO_LATE)),
    );
  }

  submitPick(playerId: string, screenId: number, seq: number, option: number, now: number): CommandReply {
    return this.guestAction(playerId, screenId, 'pick', now, (round, open) =>
      round.act(playerId, seq, () => (open ? round.pick(playerId, option) : TOO_LATE)),
    );
  }

  /** Only for teasing, because a phone can fake it and locking a phone can trigger it. */
  markLeftPage(playerId: string, now: number): boolean {
    const round = this.roundStep?.round;
    if (!round || !this.isTimedStage() || !this.players.has(playerId) || round.hasLeftPage(playerId)) return false;
    round.markLeftPage(playerId);
    this.touch(now);
    return true;
  }

  // ---------- Presenter actions ----------

  setJoinLocked(locked: boolean, now: number): void {
    if (this.joinLocked === locked) return;
    this.joinLocked = locked;
    this.touch(now);
  }

  hideEntry(entryId: string, now: number): CommandReply {
    const { step } = this;
    if (step.kind !== 'round' || step.stage === 'write') return { ok: false, code: 'not_found' };
    const reply = step.round.hide(entryId);
    if (reply.ok) {
      this.leaveRemovedCaption(now);
      this.touch(now);
    }
    return reply;
  }

  /** Frees the slot and blocks that phone's token. */
  remove(playerId: string, now: number): { tokenHash: string; closed: ClosedRequest[] } | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    this.players.delete(playerId);
    this.playerByToken.delete(player.tokenHash);
    this.playerByKey.delete(player.key);
    this.revoked.set(player.tokenHash, 'removed');
    this.roundStep?.round.removePlayer(playerId);
    this.leaveRemovedCaption(now);
    const closed = this.closeRequests((request) => request.playerId === playerId, 'denied');
    this.touch(now);
    return { tokenHash: player.tokenHash, closed };
  }

  /** Approving cancels the old phone's token, so only the new phone holds this player. */
  answerRejoin(requestId: string, approve: boolean, now: number): { requesterHash: string; oldHash: string | null } | null {
    const request = this.requests.get(requestId);
    if (!request) return null;
    this.requests.delete(requestId);
    const player = this.players.get(request.playerId);
    if (!approve || !player) {
      this.touch(now);
      return { requesterHash: request.tokenHash, oldHash: null };
    }
    const oldHash = player.tokenHash;
    this.playerByToken.delete(oldHash);
    this.revoked.set(oldHash, 'superseded');
    player.tokenHash = request.tokenHash;
    this.playerByToken.set(request.tokenHash, player.id);
    this.touch(now);
    return { requesterHash: request.tokenHash, oldHash };
  }

  expireRequests(now: number): ClosedRequest[] {
    const closed = this.closeRequests((request) => request.expiresAt <= now, 'expired');
    if (closed.length > 0) this.touch(now);
    return closed;
  }

  // ---------- Standings ----------

  /** Ties share a rank, then the next rank skips: 1, 2, 2, 4. */
  private standings(gameNumber: number | null): StandingRow[] {
    const earnedThisGame = new Map<string, number>();
    for (const step of this.steps) {
      if (!('round' in step) || step.stage !== 'reveal' || step.info.gameNumber !== gameNumber) continue;
      for (const [playerId, result] of step.round.allResults()) {
        earnedThisGame.set(playerId, (earnedThisGame.get(playerId) ?? 0) + result.points);
      }
    }
    const sorted = [...this.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
    let rank = 0;
    return sorted.map((player, index) => {
      if (index === 0 || sorted[index - 1]!.score !== player.score) rank = index + 1;
      return {
        id: player.id,
        rank,
        name: player.name,
        score: player.score,
        previous: player.score - (earnedThisGame.get(player.id) ?? 0),
      };
    });
  }

  private rankOf(playerId: string): number {
    return this.standings(null).find((row) => row.id === playerId)?.rank ?? this.players.size;
  }

  /** Everyone placed 1st to 3rd goes on the podium, ties included, and the list fills the rest of the TV. */
  private finalLayout(): { podium: StandingRow[]; rows: StandingRow[]; plan: PodiumPlan } {
    const all = this.standings(null);
    const podium = all.filter((row) => row.rank <= 3);
    const shownOnPodium = Math.min(podium.length, 3);
    const rows = all.filter((row) => row.rank > 3).slice(0, Math.max(0, LEADERBOARD_ROWS - shownOnPodium));
    const plan = podiumPlan([...new Set(podium.map((row) => row.rank))], rows.length);
    return { podium, rows, plan };
  }

  /** When a guest's place appears on the TV. Anyone not on it waits for the list, then sees theirs. */
  private landsAt(playerId: string): number {
    const { podium, rows, plan } = this.finalLayout();
    const medal = podium.find((row) => row.id === playerId);
    let at: number;
    if (medal) {
      at = plan.medalTimes[medal.rank as 1 | 2 | 3] ?? plan.lastMs;
    } else {
      const index = rows.findIndex((row) => row.id === playerId);
      at = index >= 0 ? plan.listTimes[index]! : PODIUM.listAtMs;
    }
    return Math.min(this.revealStartedAt + at, this.revealLastRowAt) + PODIUM.phoneDelayMs;
  }

  // ---------- Views ----------

  private timerView(): TimerView {
    const { endsAt, totalMs, pausedRemainingMs, cutShort } = this.timer!;
    return { endsAt, totalMs, pausedRemainingMs, cutShort };
  }

  private hostScreen(): HostScreen {
    const { step } = this;
    switch (step.kind) {
      case 'lobby':
      case 'title':
        return step;
      case 'tips':
        return { kind: 'tips', tips: this.setup.tips ?? [] };
      case 'final': {
        const { podium, rows } = this.finalLayout();
        return {
          kind: 'final',
          podium,
          rows,
          playerCount: this.players.size,
          startedAt: this.revealStartedAt,
          endsAt: this.revealLastRowAt,
          shown: this.podiumShown,
        };
      }
      case 'standings':
        return {
          kind: 'standings',
          gameNumber: step.gameNumber,
          game: step.game,
          rows: this.standings(step.gameNumber).slice(0, LEADERBOARD_ROWS),
          playerCount: this.players.size,
        };
      case 'gallery':
        return { kind: 'gallery', round: step.info, images: step.images, place: step.place };
      case 'pin': {
        const { round } = step;
        if (step.stage === 'guess') {
          return {
            kind: 'guess',
            round: step.info,
            timer: this.timerView(),
            doneIds: this.present(round.guessedIds()),
          };
        }
        const { lat, lng, label } = round.config.place;
        return {
          kind: 'pinReveal',
          round: step.info,
          target: { lat, lng, label },
          pins: round.revealPins((id) => this.players.get(id)?.name ?? null),
          startedAt: this.revealStartedAt,
          endsAt: this.revealEndsAt,
        };
      }
      case 'choice': {
        const { round } = step;
        if (step.stage === 'pick') {
          return {
            kind: 'pick',
            round: step.info,
            timer: this.timerView(),
            options: round.config.options,
            doneIds: this.present(round.guessedIds()),
          };
        }
        return {
          kind: 'pickReveal',
          round: step.info,
          rows: round.revealRows((id) => this.players.has(id)),
          right: [...this.players.values()]
            .filter((player) => round.resultOf(player.id)?.correct)
            .map((player) => player.name),
          answered: this.present(round.guessedIds()).length,
          startedAt: this.revealStartedAt,
          endsAt: this.revealEndsAt,
        };
      }
      case 'round': {
        const { round, info } = step;
        if (step.stage === 'write') {
          return { kind: 'write', round: info, timer: this.timerView(), doneIds: this.present(round.writerIds()) };
        }
        if (step.stage === 'show') {
          const live = round.allEntries();
          return {
            kind: 'show',
            round: info,
            timer: this.timerView(),
            entry: live.find((entry) => entry.id === this.showOrder[this.showIndex])!,
            ...this.showPosition(live),
          };
        }
        if (step.stage === 'vote') {
          return {
            kind: 'vote',
            round: info,
            timer: this.timerView(),
            entries: round.allEntries(),
            doneIds: this.present(round.voterIds()),
          };
        }
        return {
          kind: 'reveal',
          round: info,
          rows: round.revealRows((id) => this.players.get(id)?.name ?? null),
          startedAt: this.revealStartedAt,
          endsAt: this.revealEndsAt,
        };
      }
    }
  }

  /** Only the ids of guests still in the game. */
  private present(ids: string[]): string[] {
    return ids.filter((id) => this.players.has(id));
  }

  /** Counts only answers still in the game, so a hidden one doesn't leave a gap in the numbering. */
  private showPosition(live: readonly { id: string }[]): { number: number; count: number } {
    const shownSoFar = this.showOrder.slice(0, this.showIndex + 1);
    return {
      number: shownSoFar.filter((id) => live.some((entry) => entry.id === id)).length,
      count: live.length,
    };
  }

  hostView(): HostView {
    const { step } = this;
    const round = this.roundStep?.round;
    const showLeftPage = this.setup.showLeftPage !== false;
    return {
      role: 'host',
      version: this.version,
      roomId: this.id,
      title: this.title,
      accent: this.setup.accent ?? null,
      screen: this.hostScreen(),
      screenId: this.screenIndex,
      canAdvance:
        !this.isTimedStage(step) &&
        this.screenIndex < this.steps.length - 1 &&
        !(step.kind === 'lobby' && this.players.size === 0),
      joinLocked: this.joinLocked,
      capacity: MAX_PLAYERS,
      mapArea: this.mapArea,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        online: player.connections > 0,
        leftPage: showLeftPage && (round?.hasLeftPage(player.id) ?? false),
      })),
      rejoinRequests: [...this.requests.values()].map((request) => ({
        id: request.id,
        name: this.players.get(request.playerId)?.name ?? '',
      })),
    };
  }

  private guestScreen(player: Player): GuestScreen {
    const { step } = this;
    const standing = () => ({ total: player.score, rank: this.rankOf(player.id) });
    switch (step.kind) {
      case 'lobby':
      case 'title':
        return step;
      case 'tips':
        return { kind: 'tips', tips: this.setup.tips ?? [] };
      case 'final':
        return {
          kind: 'final',
          rank: this.rankOf(player.id),
          score: player.score,
          playerCount: this.players.size,
          landsAt: this.landsAt(player.id),
        };
      case 'standings':
        return {
          kind: 'standings',
          gameNumber: step.gameNumber,
          game: step.game,
          rank: this.rankOf(player.id),
          score: player.score,
          playerCount: this.players.size,
        };
      case 'gallery':
        return { kind: 'gallery', round: step.info, count: step.images.length };
      case 'pin': {
        const { round } = step;
        if (step.stage === 'guess') {
          return {
            kind: 'guess',
            round: step.info,
            timer: this.timerView(),
            pin: round.guessOf(player.id),
            lastSeq: round.lastSeq(player.id),
          };
        }
        const result = round.resultOf(player.id);
        return {
          kind: 'pinReveal',
          round: step.info,
          endsAt: this.revealEndsAt,
          place: round.config.place.label,
          result: { km: result?.km ?? null, points: result?.points ?? 0, ...standing() },
        };
      }
      case 'choice': {
        const { round } = step;
        if (step.stage === 'pick') {
          return {
            kind: 'pick',
            round: step.info,
            timer: this.timerView(),
            options: round.config.options,
            pick: round.guessOf(player.id),
            lastSeq: round.lastSeq(player.id),
          };
        }
        const result = round.resultOf(player.id);
        return {
          kind: 'pickReveal',
          round: step.info,
          endsAt: this.revealEndsAt,
          answer: round.config.options[round.config.answer] ?? '',
          result: {
            picked: result !== null,
            correct: result?.correct ?? false,
            points: result?.points ?? 0,
            ...standing(),
          },
        };
      }
      case 'round': {
        const { round } = step;
        if (step.stage === 'write') {
          return {
            kind: 'write',
            round: step.info,
            timer: this.timerView(),
            answer: round.answerOf(player.id),
            triesLeft: round.triesLeft(player.id),
            lastSeq: round.lastSeq('write', player.id),
          };
        }
        if (step.stage === 'show') {
          return { kind: 'show', round: step.info, ...this.showPosition(round.allEntries()) };
        }
        if (step.stage === 'vote') {
          return {
            kind: 'vote',
            round: step.info,
            timer: this.timerView(),
            options: round.ballotFor(player.id),
            vote: round.voteOf(player.id),
            voteCleared: round.voteWasCleared(player.id),
            lastSeq: round.lastSeq('vote', player.id),
          };
        }
        const result = round.resultOf(player.id);
        return {
          kind: 'reveal',
          round: step.info,
          endsAt: this.revealEndsAt,
          result: {
            wrote: round.answerOf(player.id) !== null,
            foundReal: result.foundReal,
            votes: result.votes,
            top: round.isTop(player.id),
            points: result.points,
            ...standing(),
          },
        };
      }
    }
  }

  guestView(playerId: string): GuestView | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    return {
      role: 'guest',
      version: this.version,
      title: this.title,
      accent: this.setup.accent ?? null,
      screen: this.guestScreen(player),
      screenId: this.screenIndex,
      you: { name: player.name },
      playerCount: this.players.size,
      capacity: MAX_PLAYERS,
      mapArea: this.mapArea,
    };
  }

  // ---------- Saving and restoring ----------

  /** Holds only token hashes, so a leaked snapshot can't be used to take over a player. */
  toSnapshot(): RoomSnapshot {
    return {
      schema: 3,
      id: this.id,
      setup: this.setup,
      screenIndex: this.screenIndex,
      joinLocked: this.joinLocked,
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      players: [...this.players.values()].map(({ connections: _connections, offlineSince: _offline, ...player }) => player),
      revoked: [...this.revoked.entries()],
      rounds: this.roundsOf(WriteVoteRound).map((round) => round.toState()),
      pinRounds: this.roundsOf(PinRound).map((round) => round.toState()),
      choiceRounds: this.roundsOf(ChoiceRound).map((round) => round.toState()),
    };
  }

  /**
   * Returns null for anything damaged or from an unknown version. Everyone starts
   * offline, an in-progress timer starts again, and points already scored stay scored.
   */
  static fromSnapshot(value: unknown, now: number = Date.now()): Room | null {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) return null;
    const data = parsed.data;
    const rounds = parseAll(data.rounds, WriteVoteRound.parseState);
    const pinRounds = parseAll(data.pinRounds, PinRound.parseState);
    const choiceRounds = parseAll(data.choiceRounds ?? [], ChoiceRound.parseState);
    if (!rounds || !pinRounds || !choiceRounds) return null;
    const counts = [rounds.length, pinRounds.length, choiceRounds.length];
    const room = new Room(data.id, data.setup, data.createdAt, { rounds, pinRounds, choiceRounds });
    const built = [room.roundsOf(WriteVoteRound), room.roundsOf(PinRound), room.roundsOf(ChoiceRound)];
    if (data.screenIndex >= room.steps.length || built.some((list, index) => list.length !== counts[index])) {
      return null;
    }
    room.screenIndex = data.screenIndex;
    room.joinLocked = data.joinLocked;
    room.version = data.version;
    room.updatedAt = data.updatedAt;
    for (const player of data.players) {
      room.players.set(player.id, { ...player, connections: 0, offlineSince: now });
      room.playerByToken.set(player.tokenHash, player.id);
      room.playerByKey.set(player.key, player.id);
    }
    for (const [hash, reason] of data.revoked) room.revoked.set(hash, reason);

    // A reveal or the podium comes back fully shown. A timed stage gets its full time again.
    const { step } = room;
    const roundStep = room.roundStep;
    if (step.kind === 'final' || roundStep?.stage === 'reveal') {
      room.revealStartedAt = now;
      room.revealLastRowAt = now;
      room.revealEndsAt = now;
      room.podiumShown = step.kind === 'final';
    } else if (room.showing) {
      room.enterStep(room.screenIndex, now);
    } else if (roundStep && room.isTimedStage()) {
      room.startTimer(room.stageMs(roundStep), now);
    }
    return room;
  }

  private touch(now: number): void {
    this.version += 1;
    this.updatedAt = now;
  }
}
