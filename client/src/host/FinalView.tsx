import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { HostScreen, StandingRow } from '../../../shared/protocol.js';
import { PODIUM, podiumPlan, type Medal } from '../../../shared/reveal.js';
import { ordinal } from '../theme/games.js';
import { useRollUp } from './RoundViews.js';

type FinalScreen = Extract<HostScreen, { kind: 'final' }>;

/** How each place appears: still to come, landing while the room watches, or already there. */
type Arrival = 'waiting' | 'landing' | 'appear' | 'settled';

const MEDALS: readonly Medal[] = [1, 2, 3];
const CONFETTI_MS = 3400;

/** Milliseconds since the podium started, timed from the server so a refreshed TV picks up where it was. */
function useElapsed(startedAt: number, endsAt: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Date.now() >= endsAt) {
      setTick((tick) => tick + 1);
      return;
    }
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 100);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  const now = Date.now();
  return now >= endsAt ? Number.POSITIVE_INFINITY : now - startedAt;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Something seen still to come lands with ceremony. Arriving after it landed, as after a
 * refresh, shows it settled. A skip shows it with a quick fade, so nothing slams at once.
 */
function useArrivals(keys: string[], landed: (key: string) => boolean, skipped: boolean): (key: string) => Arrival {
  const watched = useRef(new Set<string>());
  for (const key of keys) if (!landed(key)) watched.current.add(key);
  return (key) => {
    if (!landed(key)) return 'waiting';
    if (!watched.current.has(key) || reducedMotion()) return 'settled';
    return skipped ? 'appear' : 'landing';
  };
}

function PodiumScore({ score, roll }: { score: number; roll: boolean }) {
  const shown = useRollUp(roll ? 0 : score, score);
  return (
    <p className="podium-score">
      <span className="sr-only">{score} points</span>
      <span aria-hidden="true">{shown}</span>
    </p>
  );
}

function PodiumPlace({ rank, rows, arrival }: { rank: Medal; rows: StandingRow[]; arrival: Arrival }) {
  if (arrival === 'waiting') {
    return (
      <li className={`podium-slot place-${rank} waiting`} aria-hidden="true">
        <div className="podium-card">
          <p className="podium-numeral">{rank}</p>
        </div>
      </li>
    );
  }
  const shown = rows.slice(0, PODIUM.namesPerCard);
  const more = rows.length - shown.length;
  const classes = ['podium-names', rows.length > 1 ? 'shared' : ''].filter(Boolean).join(' ');
  return (
    <li className={`podium-slot place-${rank} ${arrival}${rows.length > 1 ? ' shared' : ''}`}>
      <div className="podium-card">
        <p className="podium-rank">
          <span className="podium-numeral" aria-hidden="true">
            {rank}
          </span>
          <span className="sr-only">{ordinal(rank)} place: </span>
          {rank === 1 ? (
            <span className="podium-winner">
              <span lang="ja">優勝</span> Winner
            </span>
          ) : null}
        </p>
        <ul className={classes}>
          {shown.map((row) => (
            <li key={row.id}>
              <bdi>{row.name}</bdi>
            </li>
          ))}
          {more > 0 ? <li className="podium-more">and {more} more</li> : null}
        </ul>
        <PodiumScore score={rows[0]!.score} roll={arrival === 'landing'} />
      </div>
    </li>
  );
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  spin: number;
  angle: number;
  colour: string;
  flutter: number;
}

/** One burst over 1st place, then gone. Drawn on a canvas, so it costs nothing once it's over. */
function Confetti({ onDone }: { onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) {
      onDone();
      return;
    }
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = element.clientWidth;
    const height = element.clientHeight;
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    context.scale(ratio, ratio);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const colours = ['#ecd58c', '#c9a44c', '#f5f2ea', '#d98b6f', '#a9cfc4', '#cfd0ca'];
    const pieces: Piece[] = Array.from({ length: 160 }, (_, index) => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
      const speed = (38 + Math.random() * 58) * rem;
      return {
        x: width / 2 + (Math.random() - 0.5) * 18 * rem,
        y: height * 0.4,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: (0.55 + Math.random() * 0.5) * rem,
        spin: (Math.random() - 0.5) * 14,
        angle: Math.random() * Math.PI,
        colour: colours[index % colours.length]!,
        flutter: Math.random() * Math.PI * 2,
      };
    });
    const gravity = 95 * rem;
    const started = performance.now();
    let last = started;
    let frame = 0;
    const step = (time: number) => {
      const dt = Math.min(0.05, (time - last) / 1000);
      last = time;
      const age = time - started;
      context.clearRect(0, 0, width, height);
      context.globalAlpha = Math.max(0, Math.min(1, (CONFETTI_MS - age) / 900));
      for (const piece of pieces) {
        piece.vx *= 1 - 1.6 * dt;
        piece.vy = piece.vy * (1 - 1.6 * dt) + gravity * dt;
        piece.x += piece.vx * dt;
        piece.y += piece.vy * dt;
        piece.angle += piece.spin * dt;
        piece.flutter += 9 * dt;
        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.angle);
        context.scale(1, Math.abs(Math.cos(piece.flutter)) * 0.8 + 0.2);
        context.fillStyle = piece.colour;
        context.fillRect(-piece.size / 2, -piece.size / 3, piece.size, (piece.size * 2) / 3);
        context.restore();
      }
      if (age < CONFETTI_MS) frame = requestAnimationFrame(step);
      else onDone();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [onDone]);
  return <canvas ref={canvas} className="confetti" aria-hidden="true" />;
}

/** Width of each place, as a share of the full podium. 1st is about 20% wider. */
const WIDTH: Record<Medal, number> = { 1: 1.2, 2: 1, 3: 1 };
/** Left to right, the classic 2–1–3. */
const STAGE_ORDER: readonly Medal[] = [2, 1, 3];

/**
 * Places nobody holds take no room, so a tie for 1st, which leaves no 2nd, keeps the podium
 * centred instead of leaving a gap where 2nd would stand.
 */
function podiumColumns(ranks: readonly Medal[]): CSSProperties {
  const present = STAGE_ORDER.filter((rank) => ranks.includes(rank));
  const share = present.reduce((total, rank) => total + WIDTH[rank], 0) / 3.2;
  // Each place keeps the size it has on a full podium: three columns share the width less two gaps.
  const columns: Record<string, string | number> = {
    gridTemplateColumns: present.map((rank) => `${WIDTH[rank]}fr`).join(' '),
    width: `calc(${share.toFixed(4)} * (100% - 5rem) + ${(present.length - 1) * 2.5}rem)`,
  };
  for (const rank of present) columns[`--column-${rank}`] = present.indexOf(rank) + 1;
  return columns as CSSProperties;
}

export function FinalView({ screen, title, offset }: { screen: FinalScreen; title: string; offset: number }) {
  const startedAt = screen.startedAt - offset;
  const endsAt = screen.endsAt - offset;
  const timed = useElapsed(startedAt, endsAt);
  const elapsed = screen.shown ? Number.POSITIVE_INFINITY : timed;
  const ranks = MEDALS.filter((rank) => screen.podium.some((row) => row.rank === rank));
  const plan = podiumPlan(ranks, screen.rows.length);
  // The presenter skipped to the end, so the podium stopped short of its full length.
  const skipped = screen.shown || endsAt - startedAt < plan.lastMs - 50;

  const listKeys = screen.rows.map((row) => row.id);
  const listLanded = (id: string) => elapsed >= plan.listTimes[listKeys.indexOf(id)]!;
  const medalLanded = (key: string) => elapsed >= plan.medalTimes[Number(key) as Medal]!;
  const listArrival = useArrivals(listKeys, listLanded, skipped);
  const medalArrival = useArrivals(ranks.map(String), medalLanded, skipped);

  const gold = ranks.includes(1) ? medalArrival('1') : 'settled';
  const [confettiDone, setConfettiDone] = useState(false);
  const finishConfetti = useRef(() => setConfettiDone(true)).current;

  const onBoard = screen.podium.length + screen.rows.length;
  const rest = screen.playerCount - onBoard;
  const columns = Math.ceil(screen.rows.length / 2);

  return (
    <>
      <header className="tv-header final-head">
        <div>
          <p className="tv-kicker">{title}</p>
          <h1 className="tv-title">Final standings</h1>
        </div>
      </header>
      {screen.podium.length === 0 ? (
        <p className="board-more">Nobody is left in the game.</p>
      ) : (
        <ol className="podium" style={podiumColumns(ranks)} aria-label="Podium">
          {ranks.map((rank) => (
            <PodiumPlace
              key={rank}
              rank={rank}
              rows={screen.podium.filter((row) => row.rank === rank)}
              arrival={medalArrival(String(rank))}
            />
          ))}
        </ol>
      )}
      {screen.rows.length > 0 ? (
        <ol className="final-list" style={{ '--list-rows': columns } as CSSProperties} aria-label="Everyone else">
          {screen.rows.map((row) => {
            const arrival = listArrival(row.id);
            return (
              <li key={row.id} className={`board-row ${arrival}`} aria-hidden={arrival === 'waiting' ? true : undefined}>
                <span className="board-rank">{row.rank}</span>
                <span className="board-name">
                  <bdi>{row.name}</bdi>
                </span>
                <span className="board-score">{row.score}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {rest > 0 && elapsed >= PODIUM.listAtMs ? (
        <p className="board-more">
          {rest} more {rest === 1 ? 'player' : 'players'} on their phones
        </p>
      ) : null}
      {(gold === 'landing' || gold === 'appear') && !confettiDone ? <Confetti onDone={finishConfetti} /> : null}
    </>
  );
}
