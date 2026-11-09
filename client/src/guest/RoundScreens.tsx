import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_ANSWER_LENGTH } from '../../../shared/constants.js';
import type {
  ActionReply,
  ErrorCode,
  GameType,
  GuestScreen,
  RoundInfo,
  RoundResult,
  TimerView,
} from '../../../shared/protocol.js';
import { toLocalTimes } from '../net/clock.js';
import { safeStorage } from '../net/socket.js';
import { GAME_NAMES, ordinal, roundName, roundPosition } from '../theme/games.js';
import { ActionButton, useLockedAction } from '../ui/ActionButton.js';
import { OptionBox } from '../ui/OptionBox.js';
import { PhotoThumb } from '../ui/Photo.js';
import { StatusArea, type StatusContent } from '../ui/StatusArea.js';
import { TimerStrip } from '../ui/TimerStrip.js';
import { choiceStatus, useInstantChoice } from './useInstantChoice.js';

const COUNT_SHOWN_FROM = MAX_ANSWER_LENGTH - 20;

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  too_similar: 'Too close to another answer. Try something different.',
  too_soon: 'Wait a moment, then try again.',
  no_more_tries: "That's all your tries for this word. You can still vote.",
  answer_empty: 'Write something first.',
  answer_too_long: `Use ${MAX_ANSWER_LENGTH} characters or fewer.`,
  answer_blocked: 'Try different wording.',
  too_late: 'Time ran out. Your last sent answer counts.',
  slow_down: 'That was a lot of tries. Wait a moment, then try again.',
};

const CAPTION_MESSAGES: Partial<Record<ErrorCode, string>> = {
  too_similar: 'Too close to another caption. Try something different.',
  no_more_tries: "That's all your tries for this photo. You can still vote.",
  too_late: 'Time ran out. Your last sent caption counts.',
};

function messageFor(code: ErrorCode, game: GameType = 'define'): string {
  return (game === 'caption' ? CAPTION_MESSAGES[code] : undefined) ?? MESSAGES[code] ?? "That didn't work. Try again.";
}

/** The word to define, or the photo to caption. Either way the screen's one heading. */
function RoundPrompt({ round, vote = false }: { round: RoundInfo; vote?: boolean }) {
  if (round.image === null) return <h1 className="round-prompt">{round.prompt}</h1>;
  return (
    <>
      <h1 className="sr-only">{roundPosition(round)}</h1>
      <PhotoThumb image={round.image} alt={roundPosition(round)} vote={vote} />
    </>
  );
}

type WriteScreenData = Extract<GuestScreen, { kind: 'write' }>;
type VoteScreenData = Extract<GuestScreen, { kind: 'vote' }>;
type RevealScreenData = Extract<GuestScreen, { kind: 'reveal' }>;

export interface RoundSession {
  room: string;
  offset: number;
  offline: boolean;
  sendAnswer: (screenId: number, lastSeq: number, text: string) => Promise<ActionReply | null>;
  sendVote: (screenId: number, lastSeq: number, entryId: string) => Promise<ActionReply | null>;
  sendPin: (screenId: number, lastSeq: number, lat: number, lng: number) => Promise<ActionReply | null>;
  sendPick: (screenId: number, lastSeq: number, option: number) => Promise<ActionReply | null>;
}

/** Early enough to arrive by the deadline. The server also allows a little grace for slow connections. */
const SEND_BEFORE_DEADLINE_MS = 250;

/** Runs as time runs out, and again if the deadline moves. */
export function useAtDeadline(timer: TimerView, offset: number, action: () => void): void {
  const latest = useRef(action);
  latest.current = action;
  const { endsAt, pausedRemainingMs, cutShort = false } = timer;
  useEffect(() => {
    if (pausedRemainingMs !== null) return;
    const wait = cutShort ? 0 : endsAt - offset - Date.now() - SEND_BEFORE_DEADLINE_MS;
    const id = window.setTimeout(() => latest.current(), Math.max(0, wait));
    return () => window.clearTimeout(id);
  }, [endsAt, pausedRemainingMs, offset, cutShort]);
}

export function stripLabel(session: RoundSession, weak: boolean, label: string): string {
  if (session.offline) return 'Reconnecting…';
  return weak ? 'Weak connection' : label;
}

export function WriteScreen({
  screen,
  screenId,
  session,
}: {
  screen: WriteScreenData;
  screenId: number;
  session: RoundSession;
}) {
  const draftKey = `tp:draft:${session.room}:${screenId}`;
  const [text, setText] = useState(() => screen.answer ?? safeStorage.get(draftKey) ?? '');
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<ErrorCode | null>(null);
  const [weak, setWeak] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const statusId = useId();

  const sent = screen.answer !== null && !editing;
  const outOfTries = screen.triesLeft === 0 && screen.answer === null;

  /** Keeps the keyboard open with the cursor at the end, ready to edit. */
  const focusField = () => {
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  };

  const action = useLockedAction(async () => {
    if (sent) {
      setEditing(true);
      setProblem(null);
      focusField();
      return;
    }
    if (text.trim() === '') {
      setProblem('answer_empty');
      focusField();
      return;
    }
    const reply = await session.sendAnswer(screenId, screen.lastSeq, text);
    if (!reply) return;
    if (reply.ok) {
      setEditing(false);
      setProblem(null);
      field.current?.blur();
    } else if (reply.code !== 'stale_action') {
      setProblem(reply.code);
      focusField();
    }
  });

  // Written but never sent counts as sent. An edit in progress doesn't replace the sent answer,
  // since half a sentence could be worse than what's already in.
  useAtDeadline(screen.timer, session.offset, () => {
    if (screen.answer === null && text.trim() !== '' && problem === null && !outOfTries) action.run();
  });

  let status: StatusContent = { kind: 'empty' };
  if (sent) status = { kind: 'locked' };
  else if (problem) status = { kind: 'error', text: messageFor(problem, screen.round.game) };
  else if (outOfTries) status = { kind: 'hint', text: messageFor('no_more_tries', screen.round.game) };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    // Holding Return must not send repeatedly.
    if (!event.repeat && !sent) action.run();
  };

  const { round } = screen;
  return (
    <main className="round">
      <TimerStrip
        {...toLocalTimes(screen.timer, session.offset)}
        label={stripLabel(session, weak, `${GAME_NAMES[round.game]} · ${roundPosition(round)}`)}
      />
      <div className="round-pad">
        <RoundPrompt round={round} />
        <div className="round-label">
          <label className="field-label" htmlFor={fieldId}>
            {round.game === 'caption' ? 'Your caption' : 'Your fake definition'}
          </label>
          {text.length >= COUNT_SHOWN_FROM ? (
            <span className="round-count">
              {text.length}/{MAX_ANSWER_LENGTH}
            </span>
          ) : null}
        </div>
        <textarea
          ref={field}
          id={fieldId}
          className="field-input round-field"
          value={text}
          readOnly={sent}
          maxLength={MAX_ANSWER_LENGTH}
          rows={4}
          autoCapitalize="sentences"
          autoCorrect="on"
          enterKeyHint="send"
          aria-invalid={problem ? true : undefined}
          aria-describedby={statusId}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setText(event.target.value);
            safeStorage.set(draftKey, event.target.value);
            setProblem(null);
          }}
        />
        <StatusArea id={statusId} content={status} />
        <ActionButton action={action} label={sent ? 'Edit answer' : 'Send'} onSlowChange={setWeak} />
      </div>
    </main>
  );
}

export function VoteScreen({
  screen,
  screenId,
  session,
}: {
  screen: VoteScreenData;
  screenId: number;
  session: RoundSession;
}) {
  const picked = useInstantChoice<string>({
    saved: screen.vote,
    send: (entryId) => session.sendVote(screenId, screen.lastSeq, entryId),
    messageFor: (code) => messageFor(code, screen.round.game),
  });
  const { choice, clear } = picked;

  // The chosen answer was hidden or its author removed, so this guest gets to vote again.
  const stillThere = screen.options.some((option) => option.id === choice);
  useEffect(() => {
    if (choice !== null && !stillThere) clear();
  }, [choice, stillThere, clear]);

  // A tap that didn't get through is tried once more as time runs out.
  useAtDeadline(screen.timer, session.offset, () => {
    if (choice !== null && choice !== screen.vote && stillThere && !picked.sending) picked.choose(choice);
  });

  const isCaption = screen.round.game === 'caption';
  let status = choiceStatus(picked, screen.vote);
  if (screen.options.length === 0) status = { kind: 'hint', text: 'Nothing to vote on. Watch the TV.' };
  else if (choice === null && screen.voteCleared && !picked.problem) {
    status = { kind: 'error', text: 'That answer was removed. Pick another.' };
  }

  return (
    <main className="round">
      <TimerStrip
        {...toLocalTimes(screen.timer, session.offset)}
        label={stripLabel(session, picked.slow, isCaption ? 'Vote for the best' : 'Which one is real?')}
      />
      <div className="round-pad">
        <RoundPrompt round={screen.round} vote />
        <div className="opts vote-list" role="radiogroup" aria-label={isCaption ? 'Captions' : 'Definitions'}>
          {screen.options.map((option, index) => (
            <OptionBox
              key={option.id}
              letter={letterFor(index)}
              text={option.text}
              selected={choice === option.id}
              onSelect={() => {
                if (choice !== option.id || choice !== screen.vote) picked.choose(option.id);
              }}
            />
          ))}
        </div>
        <StatusArea content={status} />
      </div>
    </main>
  );
}

/** A to Z, then AA, AB and so on, since a room of 50 can outrun the alphabet. */
export function letterFor(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26 ? letter : `A${letter}`;
}

function captionResultLine(result: RoundResult): string {
  if (!result.wrote) return 'No caption this time';
  const votes = result.votes === 1 ? '1 vote' : `${result.votes} votes`;
  if (result.top) return `Top caption, with ${votes}`;
  return result.votes > 0 ? `Your caption got ${votes}` : 'No votes this time';
}

function resultLine(result: RoundResult): string {
  const people = result.votes === 1 ? '1 person' : `${result.votes} people`;
  if (result.foundReal && result.votes > 0) return `You found it and fooled ${people}`;
  if (result.foundReal) return 'You found the real one';
  if (result.votes > 0) return `You fooled ${people}`;
  return 'Not this time';
}

export { ordinal };

/** Waits for the TV before showing a guest's result, so phones don't spoil the reveal. */
export function useHeldUntil(endsAt: number): boolean {
  const [revealed, setRevealed] = useState(() => Date.now() >= endsAt);
  useEffect(() => {
    const wait = endsAt - Date.now();
    if (wait <= 0) {
      setRevealed(true);
      return;
    }
    setRevealed(false);
    const timer = window.setTimeout(() => setRevealed(true), wait);
    return () => window.clearTimeout(timer);
  }, [endsAt]);
  return revealed;
}

export function LookUp({ round, body }: { round: RoundInfo; body: string }) {
  return (
    <main className="sheet">
      <div className="notice">
        <p className="kicker">{roundName(round)}</p>
        <h1 className="notice-title">Look up at the TV</h1>
        <p className="notice-body">{body}</p>
      </div>
    </main>
  );
}

export function RevealScreen({ screen, offset }: { screen: RevealScreenData; offset: number }) {
  const revealed = useHeldUntil(screen.endsAt - offset);
  const { round, result } = screen;
  if (!revealed) {
    return <LookUp round={round} body={round.game === 'caption' ? 'The votes are coming in.' : 'The answers are coming in.'} />;
  }
  return (
    <main className="sheet">
      <div className="waiting">
        <div className="waiting-main">
          <p className="kicker">{roundName(round)}</p>
          <h1 className="notice-title">{round.game === 'caption' ? captionResultLine(result) : resultLine(result)}</h1>
          <p className="result-points">+{result.points}</p>
        </div>
        <div className="waiting-foot">
          <span>Total {result.total}</span>
          <span>{ordinal(result.rank)} place</span>
        </div>
      </div>
    </main>
  );
}

export function RankScreen({
  heading,
  rank,
  score,
  playerCount,
}: {
  heading: string;
  rank: number;
  score: number;
  playerCount: number;
}) {
  return (
    <main className="sheet">
      <div className="waiting">
        <div className="waiting-main">
          <p className="kicker">{heading}</p>
          <h1 className="waiting-name">{ordinal(rank)} place</h1>
          <p className="result-points">{score}</p>
        </div>
        <div className="waiting-foot">
          <span>Out of {playerCount}</span>
          <span>Look up at the TV</span>
        </div>
      </div>
    </main>
  );
}

type FinalScreenData = Extract<GuestScreen, { kind: 'final' }>;

/** Waits until this guest's place is on the TV, then shows it, with a medal for the top three. */
export function FinalScreen({ screen, offset }: { screen: FinalScreenData; offset: number }) {
  const revealed = useHeldUntil(screen.landsAt - offset);
  if (!revealed) {
    return (
      <main className="sheet">
        <div className="notice">
          <p className="kicker">Final standings</p>
          <h1 className="notice-title">Look up at the TV</h1>
          <p className="notice-body">Your place appears here once it's on the TV.</p>
        </div>
      </main>
    );
  }
  const medal = screen.rank <= 3 ? screen.rank : null;
  return (
    <main className="sheet">
      <div className="waiting">
        <div className="waiting-main">
          <p className="kicker">Final standings</p>
          {medal ? (
            <p className={`medal medal-${medal}`} aria-hidden="true">
              {medal}
            </p>
          ) : null}
          {medal === 1 ? (
            <p className="medal-winner">
              <span lang="ja">優勝</span> Winner
            </p>
          ) : null}
          <h1 className="waiting-name">{ordinal(screen.rank)} place</h1>
          <p className="result-points">
            {screen.score} <span className="result-unit">points</span>
          </p>
        </div>
        <div className="waiting-foot">
          <span>Out of {screen.playerCount}</span>
          <span>Thanks for playing</span>
        </div>
      </div>
    </main>
  );
}
