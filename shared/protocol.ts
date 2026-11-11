import type { AccentColours } from './color.js';
import type { Country } from './countries.js';
import type { Spot } from './geo.js';
import type { WordClip } from './youtube.js';
/**
 * Types for everything sent between the server and clients.
 * Types only, so importing this adds nothing to the phone's download.
 */

export type GameType = 'define' | 'geo' | 'caption' | 'choice';

export type LobbyScreen = { kind: 'lobby' };
export type TitleScreen = { kind: 'title'; gameNumber: number; game: GameType };

/** All times are in the server's clock. Each device corrects for its own difference. */
export interface TimerView {
  endsAt: number;
  totalMs: number;
  /** Set while paused, when the deadline has no meaning. */
  pausedRemainingMs: number | null;
  /**
   * The presenter ended this stage early. Phones send what's on screen straight away rather
   * than by their own clock, which may be a little off, so nothing misses the grace period.
   */
  cutShort?: boolean;
}

export interface RoundInfo {
  game: GameType;
  gameNumber: number;
  /** This round's position in its game, from 1. */
  number: number;
  count: number;
  /** The word to define. Empty for a photo round. */
  prompt: string;
  /** Only ever sent once its round has started, so an early look gets nothing. */
  image: string | null;
  /** Define it: someone saying the word, which the TV plays as the word goes up. */
  clip?: WordClip;
}

/** Carries no author, timing or order clues. The id is random and changes every round. */
export interface BallotEntry {
  id: string;
  text: string;
}

export interface RevealRow {
  id: string;
  text: string;
  real: boolean;
  top: boolean;
  author: string | null;
  votes: number;
  masked: boolean;
}

/** One guest's pin at the reveal, the only time anyone sees another guest's pin. */
export interface RevealPin extends Spot {
  id: string;
  name: string;
  km: number;
  points: number;
}

/** One of Pick one's four answers at the reveal. */
export interface ChoiceRow {
  text: string;
  /** How many guests chose it. */
  count: number;
  correct: boolean;
}

export interface StandingRow {
  id: string;
  rank: number;
  name: string;
  score: number;
  /** The score before this game, so the TV can roll up from it. */
  previous: number;
}

/** One of the tips that close the night. Nothing secret, so the TV and phones get the same. */
export interface TipView {
  heading: string;
  text: string;
  places: { name: string; url: string; lat: number; lng: number }[];
  image: string | null;
}

/** The page after the podium. Phones can copy it all, since it's meant to be taken home. */
export type TipsScreen = { kind: 'tips'; tips: TipView[] };

export type HostScreen =
  | LobbyScreen
  | TipsScreen
  | TitleScreen
  | { kind: 'write'; round: RoundInfo; timer: TimerView; doneIds: string[] }
  /**
   * One answer at a time before the vote. Still anonymous, with Define it's real answer mixed in
   * and unmarked, and only the TV gets the text.
   */
  | { kind: 'show'; round: RoundInfo; timer: TimerView; entry: BallotEntry; number: number; count: number }
  | { kind: 'vote'; round: RoundInfo; timer: TimerView; entries: BallotEntry[]; doneIds: string[] }
  | { kind: 'reveal'; round: RoundInfo; rows: RevealRow[]; startedAt: number; endsAt: number }
  /** Where was this? Holds nothing about the real spot until the reveal. */
  | { kind: 'guess'; round: RoundInfo; timer: TimerView; doneIds: string[] }
  | {
      kind: 'pinReveal';
      round: RoundInfo;
      target: Spot & { label: string };
      /** Closest first. */
      pins: RevealPin[];
      startedAt: number;
      endsAt: number;
    }
  /** Pick one. The four answers in the order guests see them, with nothing to say which is right. */
  | { kind: 'pick'; round: RoundInfo; timer: TimerView; options: string[]; doneIds: string[] }
  | {
      kind: 'pickReveal';
      round: RoundInfo;
      rows: ChoiceRow[];
      /** Everyone who chose the right answer, in the order they joined. */
      right: string[];
      /** How many chose anything at all. */
      answered: number;
      startedAt: number;
      endsAt: number;
    }
  /**
   * More photos from the same moment, after a photo's result. `place` is the map game's answer,
   * already revealed, so it's safe to repeat.
   */
  | { kind: 'gallery'; round: RoundInfo; images: string[]; place: string | null }
  | { kind: 'standings'; gameNumber: number; game: GameType; rows: StandingRow[]; playerCount: number }
  | {
      kind: 'final';
      /** Everyone ranked 1st to 3rd, ties included. */
      podium: StandingRow[];
      /** The places below the podium that fit on the TV. */
      rows: StandingRow[];
      playerCount: number;
      startedAt: number;
      /** When everything is up. Moves to now when the presenter skips to the end. */
      endsAt: number;
      /**
       * Everything is up already, after a skip or a restart. Said outright, so a TV whose
       * clock estimate is off doesn't hold anything back.
       */
      shown: boolean;
    };

export interface RoundResult {
  wrote: boolean;
  foundReal: boolean;
  /** Votes this guest's entry received. */
  votes: number;
  /** Caption this: their caption got the most votes, or tied for it. */
  top: boolean;
  points: number;
  total: number;
  rank: number;
}

export interface PinRoundResult {
  /** Null when this guest didn't place a pin. */
  km: number | null;
  points: number;
  total: number;
  rank: number;
}

export interface ChoiceRoundResult {
  /** False when this guest didn't choose anything. */
  picked: boolean;
  correct: boolean;
  points: number;
  total: number;
  rank: number;
}

export type GuestScreen =
  | LobbyScreen
  | TipsScreen
  | TitleScreen
  | {
      kind: 'write';
      round: RoundInfo;
      timer: TimerView;
      answer: string | null;
      triesLeft: number;
      lastSeq: number;
    }
  | { kind: 'show'; round: RoundInfo; number: number; count: number }
  | {
      kind: 'vote';
      round: RoundInfo;
      timer: TimerView;
      options: BallotEntry[];
      vote: string | null;
      /** Their choice was removed from the ballot, so they get to vote again. */
      voteCleared: boolean;
      lastSeq: number;
    }
  | { kind: 'reveal'; round: RoundInfo; endsAt: number; result: RoundResult }
  | { kind: 'guess'; round: RoundInfo; timer: TimerView; pin: Spot | null; lastSeq: number }
  | { kind: 'pinReveal'; round: RoundInfo; endsAt: number; place: string; result: PinRoundResult }
  /** `pick` is the position of their choice in `options`. */
  | { kind: 'pick'; round: RoundInfo; timer: TimerView; options: string[]; pick: number | null; lastSeq: number }
  | { kind: 'pickReveal'; round: RoundInfo; endsAt: number; answer: string; result: ChoiceRoundResult }
  /** The photos stay on the TV; phones just point there. */
  | { kind: 'gallery'; round: RoundInfo; count: number }
  | { kind: 'standings'; gameNumber: number; game: GameType; rank: number; score: number; playerCount: number }
  /** Held until this guest's place lands on the TV, so phones don't spoil the podium. */
  | { kind: 'final'; rank: number; score: number; playerCount: number; landsAt: number };

export interface HostPlayer {
  id: string;
  name: string;
  online: boolean;
  leftPage: boolean;
}

export interface RejoinPrompt {
  id: string;
  name: string;
}

/** What the TV may see. Never holds tokens, hashes, or anything real until the reveal. */
export interface HostView {
  role: 'host';
  version: number;
  roomId: string;
  title: string;
  /** Guests can type this on the home page to join, on a hosted server. */
  joinCode: string | null;
  accent: AccentColours | null;
  screen: HostScreen;
  screenId: number;
  /** False during a timed stage, when the timer moves things on by itself. */
  canAdvance: boolean;
  joinLocked: boolean;
  capacity: number;
  /** Set when tonight has a map game, so the map can be fetched ahead of it. */
  mapArea: Country | null;
  players: HostPlayer[];
  rejoinRequests: RejoinPrompt[];
}

/** What one phone may see. Holds only that guest's details and a head count. */
export interface GuestView {
  role: 'guest';
  version: number;
  title: string;
  accent: AccentColours | null;
  screen: GuestScreen;
  screenId: number;
  you: { name: string };
  playerCount: number;
  capacity: number;
  /** Set when tonight has a map game, so the map can be fetched ahead of it. */
  mapArea: Country | null;
}

export type ErrorCode =
  | 'bad_request'
  | 'slow_down'
  | 'room_missing'
  | 'name_empty'
  | 'name_too_long'
  | 'name_blocked'
  | 'name_taken'
  | 'rejoin_busy'
  | 'join_locked'
  | 'room_full'
  | 'removed'
  | 'superseded'
  | 'stale_screen'
  | 'stage_running'
  | 'no_timer'
  | 'at_end'
  | 'no_players'
  | 'not_found'
  | 'unauthorized'
  | 'answer_empty'
  | 'answer_too_long'
  | 'answer_blocked'
  /** The same reply for the real answer and another player's, so it gives nothing away. */
  | 'too_similar'
  | 'too_soon'
  | 'no_more_tries'
  | 'too_late'
  | 'stale_action'
  | 'own_entry'
  | 'outside_country'
  | 'cannot_hide';

export type Failure = { ok: false; code: ErrorCode };

export type JoinState = 'open' | 'locked' | 'full';

export type GuestStatus =
  | { ok: true; status: 'joined'; view: GuestView }
  | { ok: true; status: 'pending'; title: string }
  | { ok: true; status: 'new'; title: string; joinState: JoinState };

export type HelloReply = GuestStatus | Failure;
export type JoinReply = GuestStatus | Failure;
export type HostHelloReply = { ok: true; view: HostView } | Failure;
export type CommandReply = { ok: true } | Failure;
export type TimeReply = { ok: true; now: number } | Failure;
/** Includes the guest's fresh view, so the phone never shows a moment of old state. */
export type ActionReply = { ok: true; view: GuestView } | (Failure & { view?: GuestView });

export type HostCommand =
  /** Names the screen it was pressed on, so a double press can't skip one. */
  | { type: 'next'; screenId: number }
  | { type: 'skipTimer'; screenId: number }
  | { type: 'addTime'; screenId: number }
  /** States the wanted value rather than toggling, so a double press changes nothing extra. */
  | { type: 'setPaused'; paused: boolean }
  | { type: 'setJoinLocked'; locked: boolean }
  | { type: 'remove'; playerId: string }
  | { type: 'hideEntry'; entryId: string }
  | { type: 'answerRejoin'; requestId: string; approve: boolean };

export type RejoinResult = 'approved' | 'denied' | 'expired' | 'cancelled';
export type KickReason = 'removed' | 'superseded';
/** Why a connection was let go: a kick, or `ended` when the presenter deleted the whole game. */
export type GoneReason = KickReason | 'ended';

export interface ServerToClient {
  view: (view: HostView | GuestView) => void;
  'rejoin:result': (result: RejoinResult) => void;
  kicked: (reason: GoneReason) => void;
}
