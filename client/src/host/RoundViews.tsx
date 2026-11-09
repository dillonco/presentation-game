import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { HostPlayer, HostScreen, RevealRow, RoundInfo, StandingRow, TimerView } from '../../../shared/protocol.js';
import { CHOICE_REVEAL, revealRowTimes } from '../../../shared/reveal.js';
import { toLocalTimes } from '../net/clock.js';
import { answerName, GAME_NAMES, roundPosition } from '../theme/games.js';
import type { Gif } from '../theme/gifs.js';
import type { WordClip } from '../../../shared/youtube.js';
import { TvPhoto } from '../ui/Photo.js';
import { YouTubeClip, type ClipState } from '../ui/YouTubeClip.js';
import { setClipPlaying } from './music.js';
import { GifCard } from './GifCard.js';
import { formatSeconds, Sunbar, useCountdown } from '../ui/Sunbar.js';

const PAGE_SIZE = 8;
const PAGE_MS = 6000;
const ROLL_MS = 1200;
/** Lets the word land and the room read it before anyone says it. */
const CLIP_DELAY_MS = 1500;
/** The word is said this many times as it goes up, with a pause between, so everyone catches it. */
const CLIP_PLAYS = 3;
const CLIP_GAP_MS = 5000;

/**
 * The captions sit in a column beside the photo, so how many fit depends on how long they
 * are. All sizes are in rem, which scale with the TV.
 */
const CAPTION_LINE_LENGTH = 64;
const CAPTION_LINE_HEIGHT = 2.5;
const CAPTION_ROW_PADDING = 1.9;
const CAPTION_DETAIL_HEIGHT = 2.1;
const VOTE_LIST_HEIGHT = 40;
const REVEAL_LIST_HEIGHT = 49;
/** Japanese and emoji take about twice the width of a Latin letter. */
const WIDE_CHARACTER = /[⺀-퟿豈-﫿＀-￯]|\p{Extended_Pictographic}/u;

function captionHeight(text: string, hasDetail: boolean): number {
  let width = 0;
  for (const character of text) width += WIDE_CHARACTER.test(character) ? 2 : 1;
  // Rounded up generously, because words wrap before the line is completely full.
  const lines = Math.max(1, Math.ceil((width * 1.05) / CAPTION_LINE_LENGTH));
  return lines * CAPTION_LINE_HEIGHT + CAPTION_ROW_PADDING + (hasDetail ? CAPTION_DETAIL_HEIGHT : 0);
}

/** Splits into pages that each fit the column, so a long caption is never cut off. */
function captionPages<T extends { text: string }>(entries: readonly T[]): T[][] {
  const pages: T[][] = [];
  let height = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const needed = captionHeight(entry.text, false);
    if (height + needed > VOTE_LIST_HEIGHT || pages.at(-1)!.length >= PAGE_SIZE) {
      pages.push([]);
      height = 0;
    }
    pages.at(-1)!.push(entry);
    height += needed;
  }
  return pages;
}

/** The newest rows that fit, since the ones people chose arrive last. */
function captionRowsThatFit<T extends { text: string }>(rows: readonly T[]): T[] {
  let height = 0;
  let first = rows.length;
  while (first > 0) {
    height += captionHeight(rows[first - 1]!.text, true);
    if (height > REVEAL_LIST_HEIGHT && first < rows.length) break;
    first -= 1;
  }
  return rows.slice(first);
}

function roundLine(round: RoundInfo): string {
  return `${GAME_NAMES[round.game]} · ${roundPosition(round)}`;
}

function RoundHeader({ round, timer, offset }: { round: RoundInfo; timer: TimerView; offset: number }) {
  const countdown = useCountdown(toLocalTimes(timer, offset));
  const classes = countdown.seconds <= 10 ? 'tv-clock last' : 'tv-clock';
  return (
    <>
      <Sunbar countdown={countdown} className="tv-sunbar" />
      <header className="tv-round-head">
        <p className="tv-round-line">
          {roundLine(round)}
          {countdown.paused ? ' · Paused' : ''}
          {countdown.done ? " · Time's up" : ''}
        </p>
        <p className={classes} aria-hidden="true">
          {formatSeconds(countdown.seconds)}
        </p>
        <span className="sr-only" role="timer" aria-live={countdown.seconds === 10 ? 'polite' : 'off'}>
          {countdown.seconds} {countdown.seconds === 1 ? 'second' : 'seconds'} left
        </span>
      </header>
    </>
  );
}

function namesTier(count: number): string {
  if (count <= 18) return 'tier-1';
  if (count <= 32) return 'tier-2';
  return 'tier-3';
}

/** Who has finished, without saying what anyone wrote or chose. */
function Progress({ players, doneIds, verb }: { players: HostPlayer[]; doneIds: string[]; verb: string }) {
  const done = new Set(doneIds);
  return (
    <section className="tv-progress" aria-label="Progress">
      <p className="tv-progress-count">
        {doneIds.length} of {players.length} {verb}
      </p>
      <ul className={`names ${namesTier(players.length)}`}>
        {players.map((player) => {
          const classes = [done.has(player.id) ? 'done' : 'waiting-name-row', player.online ? '' : 'offline']
            .filter(Boolean)
            .join(' ');
          return (
            <li key={player.id} className={classes}>
              {player.name}
              {player.leftPage ? <span title="Left the page"> 👀</span> : null}
              {done.has(player.id) ? <span className="sr-only"> (done)</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A photo on the left, and whatever this stage needs on the right. */
function PhotoStage({
  round,
  roomy = false,
  heading,
  long = false,
  rule,
  children,
}: {
  round: RoundInfo;
  roomy?: boolean;
  heading: string;
  /** A question rather than a short heading, so it gets a smaller size. */
  long?: boolean;
  rule?: string;
  children?: ReactNode;
}) {
  return (
    <div className={roomy ? 'tv-photo-stage roomy' : 'tv-photo-stage'}>
      <TvPhoto image={round.image!} alt={roundPosition(round)} />
      <div className="tv-photo-side">
        <div className="tv-word small">
          <h1 className={long ? 'tv-word-text question' : 'tv-word-text'}>{heading}</h1>
          {rule ? <p className="tv-word-rule">{rule}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Someone saying the word, shortly after it goes up, then twice more with a pause between.
 * Only the sound comes through: the video's title and picture can give the meaning away, so
 * the player stays invisible and a small "Listen" shows while the word is being said.
 * `replay` counts presses of H, so only a press after this word went up plays it again, once.
 */
function WordClipCard({ clip, replay, muted }: { clip: WordClip; replay: number; muted: boolean }) {
  const [play, setPlay] = useState(0);
  const [state, setState] = useState<ClipState>('loading');
  const [firstReplay] = useState(replay);
  const left = useRef(CLIP_PLAYS - 1);
  const gap = useRef<number>();
  useEffect(() => {
    const timer = window.setTimeout(() => setPlay(1), CLIP_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(gap.current);
    };
  }, []);
  useEffect(() => {
    if (replay === firstReplay) return;
    window.clearTimeout(gap.current);
    left.current = 0;
    setPlay((count) => count + 1);
  }, [replay, firstReplay]);
  // The music waits from the first play until the last one has finished.
  useEffect(() => () => setClipPlaying(false), []);
  const onState = (next: ClipState) => {
    setState(next);
    if (next === 'playing') setClipPlaying(true);
    if (next === 'failed' || (next === 'stopped' && left.current <= 0)) setClipPlaying(false);
    if (next !== 'stopped' || left.current <= 0) return;
    left.current -= 1;
    gap.current = window.setTimeout(() => setPlay((count) => count + 1), CLIP_GAP_MS);
  };
  const playing = state === 'playing';
  return (
    <>
      <p className={playing ? 'tv-listen shown' : 'tv-listen'} aria-hidden="true">
        <span className="tv-listen-mark">♪</span> Listen
      </p>
      <div className="tv-clip" aria-hidden="true">
        <YouTubeClip clip={clip} play={play} muted={muted} title="Someone saying the word" onState={onState} />
      </div>
    </>
  );
}

export function WriteView({
  screen,
  players,
  offset,
  replay = 0,
  muted = false,
}: {
  screen: Extract<HostScreen, { kind: 'write' }>;
  players: HostPlayer[];
  offset: number;
  /** Goes up each time the presenter asks to hear the word again. */
  replay?: number;
  muted?: boolean;
}) {
  if (screen.round.image !== null) {
    return (
      <>
        <RoundHeader round={screen.round} timer={screen.timer} offset={offset} />
        <PhotoStage round={screen.round} roomy heading="Write your best caption" rule="On your phone.">
          <Progress players={players} doneIds={screen.doneIds} verb="in" />
        </PhotoStage>
      </>
    );
  }
  const { clip } = screen.round;
  return (
    <>
      <RoundHeader round={screen.round} timer={screen.timer} offset={offset} />
      <section className={clip ? 'tv-word has-clip' : 'tv-word'}>
        <h1 className={wordClass(screen.round.prompt)}>{screen.round.prompt}</h1>
        <p className="tv-word-rule">Write a convincing fake definition on your phone.</p>
        {clip ? (
          <WordClipCard
            key={`${screen.round.gameNumber}-${screen.round.number}`}
            clip={clip}
            replay={replay}
            muted={muted}
          />
        ) : null}
      </section>
      <Progress players={players} doneIds={screen.doneIds} verb="in" />
    </>
  );
}

export function GuessView({
  screen,
  players,
  offset,
}: {
  screen: Extract<HostScreen, { kind: 'guess' }>;
  players: HostPlayer[];
  offset: number;
}) {
  return (
    <>
      <RoundHeader round={screen.round} timer={screen.timer} offset={offset} />
      <PhotoStage round={screen.round} roomy heading="Where was this?" rule="Drop a pin on your phone.">
        <Progress players={players} doneIds={screen.doneIds} verb="in" />
      </PhotoStage>
    </>
  );
}

const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];
const LONG_QUESTION = 32;

function questionOf(round: RoundInfo): string {
  return round.prompt || 'Which one is right?';
}

/** Pick one: the photo, the question, and the four answers lettered as they are on the phones. */
export function PickView({
  screen,
  players,
  offset,
}: {
  screen: Extract<HostScreen, { kind: 'pick' }>;
  players: HostPlayer[];
  offset: number;
}) {
  const question = questionOf(screen.round);
  return (
    <>
      <RoundHeader round={screen.round} timer={screen.timer} offset={offset} />
      <PhotoStage
        round={screen.round}
        heading={question}
        long={Array.from(question).length > LONG_QUESTION}
        rule={`Answer on your phone · ${screen.doneIds.length} of ${players.length} in`}
      >
        <ol className="choices">
          {screen.options.map((text, index) => (
            <li key={index} className="choice">
              <span className="choice-letter" aria-hidden="true">
                {CHOICE_LETTERS[index]}
              </span>
              <span className="sr-only">{CHOICE_LETTERS[index]}: </span>
              <span className="entry-text">{text}</span>
            </li>
          ))}
        </ol>
      </PhotoStage>
    </>
  );
}

/** How far into a timed reveal the TV is. Once it's over, or skipped, everything shows. */
function useRevealElapsed(startedAt: number, endsAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Date.now() >= endsAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  const current = Math.max(now, Date.now());
  return current >= endsAt ? Number.POSITIVE_INFINITY : current - startedAt;
}

function rightLine(right: readonly string[], answered: number): string {
  if (answered === 0) return 'Nobody answered this time';
  if (right.length === 0) return 'Nobody got it';
  if (right.length === answered && answered > 1) return 'Everyone got it';
  return right.length === 1 ? 'Only one got it' : `${right.length} got it`;
}

/** Where everyone went fills in first, then the right answer is circled and the names arrive. */
export function PickRevealView({
  screen,
  offset,
}: {
  screen: Extract<HostScreen, { kind: 'pickReveal' }>;
  offset: number;
}) {
  const elapsed = useRevealElapsed(screen.startedAt - offset, screen.endsAt - offset);
  const countsShown = elapsed >= CHOICE_REVEAL.countsAtMs;
  const answerShown = elapsed >= CHOICE_REVEAL.answerAtMs;
  const namesShown = elapsed >= CHOICE_REVEAL.namesAtMs;
  const question = questionOf(screen.round);
  const most = Math.max(1, ...screen.rows.map((row) => row.count));
  const listed = screen.right.slice(0, CHOICE_REVEAL.names);
  const more = screen.right.length - listed.length;
  return (
    <>
      <header className="tv-round-head">
        <p className="tv-round-line">{roundLine(screen.round)}</p>
      </header>
      <PhotoStage
        round={screen.round}
        heading={question}
        long={Array.from(question).length > LONG_QUESTION}
        rule={screen.answered === 1 ? '1 answer' : `${screen.answered} answers`}
      >
        <ol className="choices">
          {screen.rows.map((row, index) => {
            const marked = answerShown && row.correct;
            const classes = ['choice', marked ? 'real' : '', answerShown && !row.correct ? 'wrong' : '']
              .filter(Boolean)
              .join(' ');
            return (
              <li key={index} className={classes}>
                <span className="choice-letter" aria-hidden="true">
                  {CHOICE_LETTERS[index]}
                </span>
                <span className="sr-only">{CHOICE_LETTERS[index]}: </span>
                <span className="entry-text">{row.text}</span>
                <span className="choice-count">
                  {countsShown ? row.count : null}
                  {countsShown ? <span className="sr-only"> chose this{marked ? ', the right answer' : ''}</span> : null}
                </span>
                <span
                  className="choice-bar"
                  aria-hidden="true"
                  style={{ '--share': countsShown ? row.count / most : 0 } as CSSProperties}
                />
                {marked ? <PencilRing /> : null}
              </li>
            );
          })}
        </ol>
        {namesShown ? (
          <div className="choice-right" role="status">
            <p className="choice-right-head">{rightLine(screen.right, screen.answered)}</p>
            {listed.length > 0 ? (
              <p className="choice-right-names">
                {listed.map((name, index) => (
                  <span key={`${name}-${index}`}>
                    <bdi>{name}</bdi>
                    {index < listed.length - 1 ? ', ' : ''}
                  </span>
                ))}
                {more > 0 ? ` and ${more} more` : ''}
              </p>
            ) : null}
          </div>
        ) : null}
      </PhotoStage>
    </>
  );
}

/** The room reads one answer at a time, with no clock, so all eyes are on the joke. */
export function ShowView({
  screen,
  onHide,
}: {
  screen: Extract<HostScreen, { kind: 'show' }>;
  onHide: (entryId: string) => void;
}) {
  const { round, entry } = screen;
  const long = Array.from(entry.text).length > 70;
  const head = (
    <header className="tv-round-head">
      <p className="tv-round-line">
        {roundLine(round)}
        {screen.timer.pausedRemainingMs !== null ? ' · Paused' : ''}
      </p>
    </header>
  );
  const answer = (
    <button key={entry.id} type="button" className={long ? 'tv-show-text long' : 'tv-show-text'} onClick={() => onHide(entry.id)}>
      <span className="sr-only">Hide this answer: </span>
      <span className="entry-text">{entry.text}</span>
    </button>
  );
  const position = `${answerName(round)} ${screen.number} of ${screen.count}`;
  if (round.image === null) {
    return (
      <>
        {head}
        <section className="tv-word small">
          <h1 className={wordClass(round.prompt)}>{round.prompt}</h1>
          <p className="tv-word-rule">{position}</p>
        </section>
        <div className="tv-show solo">{answer}</div>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="tv-photo-stage">
        <TvPhoto image={round.image} alt={roundPosition(round)} />
        <div className="tv-photo-side tv-show">
          <h1 className="tv-show-count">{position}</h1>
          {answer}
        </div>
      </div>
    </>
  );
}

function useAutoPage(pages: number): number {
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (pages <= 1) {
      setPage(0);
      return;
    }
    const timer = window.setInterval(() => setPage((current) => (current + 1) % pages), PAGE_MS);
    return () => window.clearInterval(timer);
  }, [pages]);
  return Math.min(page, pages - 1);
}

export function VoteView({
  screen,
  players,
  offset,
  onHide,
}: {
  screen: Extract<HostScreen, { kind: 'vote' }>;
  players: HostPlayer[];
  offset: number;
  onHide: (entryId: string) => void;
}) {
  const isPhoto = screen.round.image !== null;
  const groups = isPhoto ? captionPages(screen.entries) : chunks(screen.entries, PAGE_SIZE);
  const page = useAutoPage(Math.max(1, groups.length));
  const pages = groups.length;
  const shown = groups[page] ?? [];
  const entryList = (
    <ul className={!isPhoto && screen.entries.length > 4 ? 'entries two-up' : 'entries'}>
      {shown.map((entry) => (
        <li key={entry.id}>
          <button type="button" className="entry" onClick={() => onHide(entry.id)}>
            <span className="sr-only">Hide this answer: </span>
            <span className="entry-text">{entry.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
  if (isPhoto) {
    return (
      <>
        <RoundHeader round={screen.round} timer={screen.timer} offset={offset} />
        <PhotoStage
          round={screen.round}
          heading="Vote for the best"
          rule={`${screen.doneIds.length} of ${players.length} voted${pages > 1 ? ` · Page ${page + 1} of ${pages}` : ''}`}
        >
          {entryList}
        </PhotoStage>
      </>
    );
  }
  return (
    <>
      <RoundHeader round={screen.round} timer={screen.timer} offset={offset} />
      <section className="tv-word small">
        <h1 className={wordClass(screen.round.prompt)}>{screen.round.prompt}</h1>
        <p className="tv-word-rule">
          Which one is real? {screen.doneIds.length} of {players.length} voted
          {pages > 1 ? ` · Page ${page + 1} of ${pages}` : ''}
        </p>
      </section>
      {entryList}
    </>
  );
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

/** Rows arrive one at a time. Timed from the server, so a refreshed TV picks up where it was. */
function useVisibleRows(rows: readonly RevealRow[], startedAt: number, endsAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Date.now() >= endsAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  const current = Math.max(now, Date.now());
  if (current >= endsAt) return rows.length;
  const elapsed = current - startedAt;
  return Math.max(1, revealRowTimes(rows).filter((time) => time <= elapsed).length);
}

/** Very long words get a smaller size, so the rest of the screen still fits. */
function wordClass(word: string): string {
  return Array.from(word).length > 22 ? 'tv-word-text long' : 'tv-word-text';
}

/** The author sits apart from the text around it, so a right-to-left name can't scramble the count. */
function RowDetail({ row }: { row: RevealRow }) {
  const votes = row.votes === 1 ? '1 vote' : `${row.votes} votes`;
  if (row.real) return <>Real answer · {votes}</>;
  return (
    <>
      {row.top && !row.masked ? 'Top caption · ' : ''}
      <bdi>{row.author ?? 'Left the game'}</bdi> · {votes}
    </>
  );
}

export function RevealView({
  screen,
  offset,
  onHide,
}: {
  screen: Extract<HostScreen, { kind: 'reveal' }>;
  offset: number;
  onHide: (entryId: string) => void;
}) {
  const visible = useVisibleRows(screen.rows, screen.startedAt - offset, screen.endsAt - offset);
  const arrived = screen.rows.slice(0, visible);
  const isPhoto = screen.round.image !== null;
  const shown = isPhoto ? captionRowsThatFit(arrived) : arrived.slice(-PAGE_SIZE);
  const rowList = (
    <ul className={!isPhoto && screen.rows.length > 4 ? 'entries two-up' : 'entries'}>
      {shown.map((row) => (
        <li key={row.id} className="entry-row">
          {row.real ? (
            <div className="entry real">
              <span className="entry-text">{row.text}</span>
              <span className="entry-detail"><RowDetail row={row} /></span>
              <PencilRing />
            </div>
          ) : (
            <button
              type="button"
              className={row.top && !row.masked ? 'entry real' : 'entry'}
              disabled={row.masked}
              onClick={() => onHide(row.id)}
            >
              {row.masked ? null : <span className="sr-only">Hide this answer: </span>}
              <span className="entry-text">{row.masked ? 'Hidden' : row.text}</span>
              <span className="entry-detail"><RowDetail row={row} /></span>
              {row.top && !row.masked ? <PencilRing /> : null}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
  if (isPhoto) {
    return (
      <>
        <header className="tv-round-head">
          <p className="tv-round-line">{roundLine(screen.round)}</p>
        </header>
        <PhotoStage
          round={screen.round}
          heading={captionRevealHeading(screen.rows.length)}
          rule={screen.rows.length === 1 ? 'Only one caption, so no vote.' : undefined}
        >
          {screen.rows.length > 0 ? rowList : null}
        </PhotoStage>
      </>
    );
  }
  return (
    <>
      <header className="tv-round-head">
        <p className="tv-round-line">{roundLine(screen.round)}</p>
      </header>
      <section className="tv-word small">
        <h1 className={wordClass(screen.round.prompt)}>{screen.round.prompt}</h1>
      </section>
      {rowList}
    </>
  );
}

function captionRevealHeading(rows: number): string {
  if (rows === 0) return 'No captions this time';
  return rows === 1 ? 'The only caption' : 'The results';
}

function PencilRing() {
  return (
    <svg className="pencil-ring" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 8 C 78 6, 94 26, 92 50 C 90 76, 70 94, 46 92 C 22 90, 6 72, 8 48 C 10 24, 30 8, 56 10" />
    </svg>
  );
}

/** Digits roll up once, except for anyone who asked their device to reduce motion. */
export function useRollUp(from: number, to: number): number {
  const [value, setValue] = useState(from);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) {
      setValue(to);
      return;
    }
    const startedAt = performance.now();
    let frame = 0;
    const step = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / ROLL_MS);
      const eased = 1 - (1 - progress) ** 3;
      setValue(Math.round(from + (to - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [from, to]);
  return value;
}

export function BoardRow({ row }: { row: StandingRow }) {
  const shown = useRollUp(row.previous, row.score);
  return (
    <li className="board-row">
      <span className="board-rank">{row.rank}</span>
      <span className="board-name">{row.name}</span>
      <span className="sr-only">{row.score} points</span>
      <span className="board-score" aria-hidden="true">
        {shown}
      </span>
    </li>
  );
}

export function StandingsView({
  heading,
  sub,
  rows,
  playerCount,
  gif = null,
}: {
  heading: string;
  sub: string;
  rows: StandingRow[];
  playerCount: number;
  /** A funny GIF pinned beside the board. */
  gif?: Gif | null;
}) {
  return (
    <>
      <header className="tv-header">
        <div>
          <p className="tv-kicker">{sub}</p>
          <h1 className="tv-title">{heading}</h1>
        </div>
      </header>
      <div className="standings-body">
        <ol className="board">
          {rows.map((row) => (
            <BoardRow key={row.id} row={row} />
          ))}
        </ol>
        <GifCard gif={gif} className="standings-gif" />
      </div>
      {playerCount > rows.length ? (
        <p className="board-more">
          {playerCount - rows.length} more {playerCount - rows.length === 1 ? 'player' : 'players'} on their phones
        </p>
      ) : null}
    </>
  );
}
