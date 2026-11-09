import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { HostScreen } from '../../../shared/protocol.js';
import { allSceneryUrls } from '../theme/scenery.js';
import '../theme/scene.css';

/**
 * A hand-painted sky behind the TV, in the spirit of a hand-drawn animated film: drifting
 * cumulus, rolling hills, wind in the grass. Each part of the night has its own time of day,
 * and the in-between screens open with the clouds parting.
 */
export type Mood = 'dusk' | 'day' | 'night' | 'sunset' | 'lanterns';

export function moodFor(kind: HostScreen['kind'] | null | undefined): Mood {
  switch (kind) {
    case 'lobby':
      return 'dusk';
    case 'title':
      return 'day';
    case 'standings':
      return 'sunset';
    case 'final':
    case 'tips':
      return 'lanterns';
    default:
      return 'night';
  }
}

/** The screens between games, which open by parting the clouds. */
const PARTS_CLOUDS: ReadonlySet<Mood> = new Set(['day', 'sunset', 'lanterns']);
const FADE_MS = 1600;

type Particle = 'seeds' | 'leaves' | 'fireflies' | 'lanterns' | null;

interface MoodSetup {
  clouds: number;
  stars: number;
  particle: Particle;
  particles: number;
  land: 'hills' | 'forest';
  tree: boolean;
  poles: boolean;
  grass: boolean;
  birds: boolean;
  tower: boolean;
}

const SETUP: Record<Mood, MoodSetup> = {
  dusk: { clouds: 6, stars: 40, particle: 'seeds', particles: 18, land: 'hills', tree: true, poles: false, grass: true, birds: false, tower: false },
  day: { clouds: 7, stars: 0, particle: 'leaves', particles: 16, land: 'hills', tree: true, poles: true, grass: true, birds: true, tower: true },
  night: { clouds: 4, stars: 70, particle: 'fireflies', particles: 26, land: 'forest', tree: false, poles: false, grass: false, birds: false, tower: false },
  sunset: { clouds: 6, stars: 12, particle: null, particles: 0, land: 'hills', tree: false, poles: true, grass: true, birds: true, tower: true },
  lanterns: { clouds: 3, stars: 90, particle: 'lanterns', particles: 22, land: 'hills', tree: true, poles: false, grass: false, birds: false, tower: false },
};

/** The same "random" layout every time, so nothing jumps when the TV redraws. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Vars = CSSProperties & Record<`--${string}`, string | number>;

interface Puff {
  x: number;
  y: number;
  r: number;
}

function cloudPuffs(seed: number): Puff[] {
  const rand = seeded(seed);
  const count = 5 + Math.floor(rand() * 3);
  const puffs: Puff[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const bulge = Math.sin(t * Math.PI);
    const r = 30 + bulge * (32 + rand() * 24) + rand() * 8;
    puffs.push({ x: 60 + t * 280 + (rand() - 0.5) * 16, y: 150 - r * (0.5 + rand() * 0.25), r });
  }
  return puffs;
}

/** One cumulus: a flat, shaded underside, a body of puffs, and sunlit tops. */
const CloudShape = memo(function CloudShape({ seed }: { seed: number }) {
  const puffs = useMemo(() => cloudPuffs(seed), [seed]);
  return (
    <svg className="cloud-svg" viewBox="0 -60 400 250" aria-hidden="true" focusable="false">
      <g filter="url(#scene-paint)">
        <g className="c-shade" transform="translate(4 12)">
          {puffs.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={p.r} />
          ))}
          <rect x="40" y="120" width="320" height="42" rx="21" />
        </g>
        <g className="c-body">
          {puffs.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={p.r} />
          ))}
          <rect x="40" y="118" width="320" height="36" rx="18" />
        </g>
        <g className="c-light">
          {puffs.map((p, i) => (
            <circle key={i} cx={p.x - p.r * 0.12} cy={p.y - p.r * 0.18} r={p.r * 0.78} />
          ))}
        </g>
      </g>
    </svg>
  );
});

/** A towering summer cumulus on the horizon, the kind that fills half the sky. */
function CloudTower() {
  const rows = [
    { y: 300, xs: [110, 190, 270, 350, 430], r: 70 },
    { y: 220, xs: [150, 235, 320, 400], r: 72 },
    { y: 140, xs: [190, 275, 360], r: 70 },
    { y: 70, xs: [235, 320], r: 62 },
    { y: 15, xs: [280], r: 52 },
  ];
  const puffs = rows.flatMap((row, i) => row.xs.map((x, j) => ({ x: x + ((i * 7 + j * 13) % 20) - 10, y: row.y, r: row.r - ((i + j) % 3) * 6 })));
  return (
    <svg className="cloud-tower" viewBox="0 -60 560 440" aria-hidden="true" focusable="false">
      <g filter="url(#scene-paint)">
        <g className="c-shade" transform="translate(10 16)">
          {puffs.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={p.r} />
          ))}
        </g>
        <g className="c-body">
          {puffs.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={p.r} />
          ))}
        </g>
        <g className="c-light">
          {puffs.map((p, i) => (
            <circle key={i} cx={p.x - p.r * 0.14} cy={p.y - p.r * 0.2} r={p.r * 0.74} />
          ))}
        </g>
      </g>
    </svg>
  );
}

function treeline(seed: number, base: number, low: number, high: number): string {
  const rand = seeded(seed);
  let d = `M0 400 L0 ${base}`;
  let x = 0;
  while (x < 1600) {
    const w = 26 + rand() * 46;
    const h = low + rand() * (high - low);
    const next = Math.min(1600, x + w);
    const y = base + (rand() - 0.5) * 8;
    if (rand() < 0.45) d += ` Q ${(x + next) / 2} ${base - h * 2} ${next} ${y}`;
    else d += ` C ${x} ${base - h * 1.3} ${next} ${base - h * 1.3} ${next} ${y}`;
    x = next;
  }
  return `${d} L1600 400 Z`;
}

function grassPath(seed: number, from: number, step: number): string {
  const rand = seeded(seed);
  let d = '';
  for (let x = from; x < 1600; x += step + rand() * step) {
    const h = 30 + rand() * 50;
    const lean = (rand() - 0.3) * 18;
    d += `M${x.toFixed(1)} 100 Q ${(x + lean * 0.4).toFixed(1)} ${(100 - h * 0.6).toFixed(1)} ${(x + lean).toFixed(1)} ${(100 - h).toFixed(1)} Q ${(x + 4 + lean * 0.4).toFixed(1)} ${(100 - h * 0.5).toFixed(1)} ${(x + 7).toFixed(1)} 100 Z `;
  }
  return d;
}

function Land({ setup }: { setup: MoodSetup }) {
  const forest = useMemo(
    () => (setup.land === 'forest' ? [treeline(11, 300, 30, 70), treeline(23, 345, 30, 80)] : null),
    [setup.land],
  );
  const grass = useMemo(() => (setup.grass ? [grassPath(5, 0, 9), grassPath(9, 4, 9)] : null), [setup.grass]);
  return (
    <>
      {setup.tower ? (
        <div className="scene-tower">
          <CloudTower />
        </div>
      ) : null}
      <svg className="scene-land" viewBox="0 0 1600 400" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {forest ? (
          <>
            <path className="hill-far" d="M0 250 C 260 200, 520 210, 800 235 S 1300 200, 1600 228 L1600 400 L0 400 Z" />
            <path className="hill-mid" d={forest[0]} />
            <path className="hill-near" d={forest[1]} />
          </>
        ) : (
          <>
            <path className="hill-far" d="M0 232 C 200 172, 380 162, 560 202 S 900 152, 1100 192 S 1450 142, 1600 182 L1600 400 L0 400 Z" />
            <path className="hill-mid" d="M0 292 C 180 242, 360 252, 520 277 S 820 232, 1000 262 S 1350 227, 1600 257 L1600 400 L0 400 Z" />
            <path className="hill-near" d="M0 342 C 240 312, 480 322, 700 337 S 1100 302, 1300 322 S 1500 332, 1600 317 L1600 400 L0 400 Z" />
          </>
        )}
      </svg>
      {setup.tree ? (
        <svg className="scene-tree" viewBox="0 0 300 260" aria-hidden="true" focusable="false">
          <path className="tree-trunk" d="M140 260 L146 170 Q 120 150 100 152 Q 128 142 148 158 L152 120 L160 158 Q 182 138 210 146 Q 182 150 162 172 L166 260 Z" />
          <g className="tree-crown">
            <circle cx="150" cy="95" r="70" />
            <circle cx="88" cy="120" r="52" />
            <circle cx="212" cy="118" r="56" />
            <circle cx="118" cy="62" r="46" />
            <circle cx="186" cy="58" r="48" />
            <circle cx="60" cy="150" r="32" />
            <circle cx="244" cy="150" r="34" />
          </g>
          <g className="tree-light">
            <circle cx="132" cy="70" r="30" />
            <circle cx="92" cy="104" r="24" />
            <circle cx="178" cy="44" r="24" />
          </g>
        </svg>
      ) : null}
      {setup.poles ? (
        <svg className="scene-poles" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path className="pole-wire" d="M40 52 Q 190 82 340 46 Q 500 76 660 38 Q 810 66 960 30" />
          <path className="pole-wire" d="M40 64 Q 190 94 340 58 Q 500 88 660 50 Q 810 78 960 42" />
          {[40, 340, 660, 960].map((x, i) => (
            <g key={x} className="pole">
              <rect x={x - 2.5} y={44 - i * 4} width="5" height={156 + i * 4} />
              <rect x={x - 16} y={50 - i * 4} width="32" height="4" />
            </g>
          ))}
        </svg>
      ) : null}
      {grass ? (
        <svg className="scene-grass" viewBox="0 0 1600 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path className="grass-back" d={grass[0]} />
          <path className="grass-front" d={grass[1]} />
        </svg>
      ) : null}
    </>
  );
}

/** A photo over the painted sky, drifting slowly. It only appears once it has loaded. */
function ScenePhoto({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.onload = () => active && setLoaded(true);
    image.src = url;
    if (image.complete && image.naturalWidth > 0) setLoaded(true);
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <div
      className={loaded ? 'scene-photo shown' : 'scene-photo'}
      style={loaded ? { backgroundImage: `url("${url}")` } : undefined}
    />
  );
}

const SceneLayer = memo(function SceneLayer({
  mood,
  photo,
  entering,
}: {
  mood: Mood;
  photo: string | null;
  entering: boolean;
}) {
  const setup = SETUP[mood];
  const pieces = useMemo(() => {
    const rand = seeded(mood.length * 97 + setup.clouds * 13);
    const clouds = Array.from({ length: setup.clouds }, (_, i) => {
      const depth = i / Math.max(1, setup.clouds - 1);
      const width = 18 + depth * 26 + rand() * 8;
      const duration = 260 - depth * 140 + rand() * 40;
      return {
        seed: 31 + i * 17,
        style: {
          '--w': `${width}rem`,
          top: `${4 + rand() * 30}%`,
          '--dur': `${duration}s`,
          // Starts part-way through, so the sky is full from the first frame.
          '--delay': `${-rand() * duration}s`,
          '--fade': `${0.55 + depth * 0.45}`,
          zIndex: Math.round(depth * 10),
        } as Vars,
      };
    });
    const stars = Array.from({ length: setup.stars }, () => ({
      '--x': `${rand() * 100}%`,
      '--y': `${rand() * 55}%`,
      '--s': `${0.12 + rand() * 0.22}rem`,
      '--t': `${2 + rand() * 4}s`,
      '--delay': `${-rand() * 6}s`,
    })) as Vars[];
    const particles = Array.from({ length: setup.particles }, () => {
      const duration = setup.particle === 'lanterns' ? 26 + rand() * 24 : setup.particle === 'fireflies' ? 9 + rand() * 10 : 16 + rand() * 16;
      return {
        '--x': `${rand() * 100}%`,
        '--y': `${setup.particle === 'fireflies' ? 55 + rand() * 42 : 10 + rand() * 75}%`,
        '--s': `${0.6 + rand() * 0.8}`,
        '--dur': `${duration}s`,
        '--delay': `${-rand() * duration}s`,
        '--wobble': `${2 + rand() * 3}s`,
        '--rise': `${-4 - rand() * 14}rem`,
        '--spin': `${rand() < 0.5 ? -1 : 1}`,
      } as Vars;
    });
    return { clouds, stars, particles };
  }, [mood, setup]);

  return (
    <div className={`scene-layer mood-${mood}${entering ? ' entering' : ''}`}>
      <div className="scene-sky" />
      <div className="scene-glow" />
      {pieces.stars.length > 0 ? (
        <div className="scene-stars">
          {pieces.stars.map((style, i) => (
            <span key={i} className="star" style={style} />
          ))}
        </div>
      ) : null}
      {setup.birds ? (
        <div className="scene-birds">
          {[0, 1, 2, 3, 4].map((i) => (
            <svg key={i} className="bird" viewBox="0 0 40 16" aria-hidden="true" focusable="false">
              <path d="M2 8 Q 11 0 20 9 Q 29 0 38 8 Q 29 4 20 13 Q 11 4 2 8 Z" />
            </svg>
          ))}
        </div>
      ) : null}
      <Land setup={setup} />
      <div className="scene-clouds">
        {pieces.clouds.map((cloud) => (
          <div key={cloud.seed} className="cloud" style={cloud.style}>
            <CloudShape seed={cloud.seed} />
          </div>
        ))}
      </div>
      {photo ? <ScenePhoto url={photo} /> : null}
      {setup.particle ? (
        <div className={`scene-particles ${setup.particle}`}>
          {pieces.particles.map((style, i) => (
            <span key={i} className="particle" style={style}>
              <span className="particle-inner" />
            </span>
          ))}
        </div>
      ) : null}
      <div className="scene-veil" />
    </div>
  );
});

const PART_CLOUDS = [
  { side: 'left', x: -14, y: -12, w: 70, seed: 3 },
  { side: 'left', x: -8, y: 22, w: 76, seed: 7 },
  { side: 'left', x: -16, y: 52, w: 72, seed: 13 },
  { side: 'left', x: 14, y: 6, w: 60, seed: 19 },
  { side: 'left', x: 10, y: 40, w: 62, seed: 29 },
  { side: 'right', x: 52, y: -14, w: 74, seed: 37 },
  { side: 'right', x: 58, y: 20, w: 72, seed: 41 },
  { side: 'right', x: 50, y: 50, w: 78, seed: 43 },
  { side: 'right', x: 38, y: 4, w: 58, seed: 53 },
  { side: 'right', x: 40, y: 34, w: 60, seed: 59 },
] as const;

/** Covers the cut between screens with cloud, then draws it back like curtains. */
const CloudPart = memo(function CloudPart({ mood }: { mood: Mood }) {
  return (
    <div className={`cloud-part mood-${mood}`} aria-hidden="true">
      <div className="cloud-part-mist" />
      {PART_CLOUDS.map((cloud) => (
        <div
          key={cloud.seed}
          className={`part-cloud ${cloud.side}`}
          style={{ left: `${cloud.x}rem`, top: `${cloud.y}rem`, width: `${cloud.w}rem` } as Vars}
        >
          <CloudShape seed={cloud.seed} />
        </div>
      ))}
    </div>
  );
});

function prefersStillness(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Fetches every still once the TV has settled, so each screen change shows its picture at once. */
function usePreloadedScenery(): void {
  useEffect(() => {
    const images: HTMLImageElement[] = [];
    const timer = window.setTimeout(() => {
      for (const url of allSceneryUrls()) {
        const image = new Image();
        image.referrerPolicy = 'no-referrer';
        image.src = url;
        images.push(image);
      }
    }, 3000);
    return () => window.clearTimeout(timer);
  }, []);
}

export function Scene({ mood, photo = null }: { mood: Mood; photo?: string | null }) {
  usePreloadedScenery();
  const nextKey = useRef(1);
  const shown = useRef(`${mood}|${photo}`);
  const [layers, setLayers] = useState<{ mood: Mood; photo: string | null; key: number }[]>([
    { mood, photo, key: 0 },
  ]);
  const [part, setPart] = useState<{ mood: Mood; key: number } | null>(null);

  useEffect(() => {
    const id = `${mood}|${photo}`;
    if (shown.current === id) return;
    shown.current = id;
    const key = nextKey.current;
    nextKey.current += 1;
    // The new sky fades in over the old one, which goes once it's covered.
    setLayers((current) => [...current.slice(-1), { mood, photo, key }]);
    setPart(PARTS_CLOUDS.has(mood) && !prefersStillness() ? { mood, key } : null);
    const timer = window.setTimeout(() => {
      setLayers((current) => current.slice(-1));
      setPart(null);
    }, FADE_MS + 400);
    return () => window.clearTimeout(timer);
  }, [mood, photo]);

  return (
    <>
      <svg className="scene-defs" aria-hidden="true" focusable="false">
        <defs>
          {/* Roughens the edges a little, like gouache on paper. */}
          <filter id="scene-paint" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="4" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="9" xChannelSelector="R" yChannelSelector="G" />
            <feGaussianBlur stdDeviation="0.7" />
          </filter>
        </defs>
      </svg>
      <div className="scene" aria-hidden="true">
        {layers.map((layer, index) => (
          <SceneLayer key={layer.key} mood={layer.mood} photo={layer.photo} entering={index > 0} />
        ))}
      </div>
      {part ? <CloudPart key={part.key} mood={part.mood} /> : null}
    </>
  );
}
