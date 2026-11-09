/**
 * Sparse FM-synth beeps for the TV, in the spirit of 90s hardware. Each sound is one or two
 * sine carriers bent by a sine modulator, so nothing is downloaded. Phones stay silent.
 */
import { safeStorage } from '../net/socket.js';
import { setMusicMuted, startMusic } from './music.js';

export type Cue = 'join' | 'chime' | 'tick' | 'timeUp' | 'real' | 'listIn' | 'place3' | 'place2' | 'place1';

/** When several cues land at once, such as after skipping to the end, only the most important plays. */
export const CUE_PRIORITY: Record<Cue, number> = {
  tick: 1,
  join: 1,
  listIn: 2,
  timeUp: 3,
  real: 4,
  chime: 4,
  place3: 5,
  place2: 6,
  place1: 7,
};

interface Voice {
  /** Seconds after the cue starts. */
  at: number;
  freq: number;
  /** Modulator frequency as a multiple of the carrier. Whole numbers sound warm, others like bells. */
  ratio: number;
  /** How far the modulator bends the carrier. Higher is brighter, and it fades as the note decays. */
  index: number;
  attack: number;
  decay: number;
  gain: number;
}

const NOTE = {
  G2: 98,
  C4: 261.63,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  B5: 987.77,
  C6: 1046.5,
  D6: 1174.66,
  E6: 1318.51,
  G6: 1567.98,
  B6: 1975.53,
};

const bell = (at: number, freq: number, gain = 0.1, decay = 1.3): Voice => ({ at, freq, ratio: 3.5, index: 1.4, attack: 0.004, decay, gain });
const brass = (at: number, freq: number, gain = 0.09, decay = 0.55): Voice => ({ at, freq, ratio: 1, index: 2.6, attack: 0.025, decay, gain });
const thump = (at = 0, gain = 0.32): Voice => ({ at, freq: NOTE.G2, ratio: 1, index: 2.2, attack: 0.003, decay: 0.32, gain });

const CUES: Record<Cue, Voice[]> = {
  join: [{ at: 0, freq: NOTE.G6, ratio: 2, index: 0.7, attack: 0.003, decay: 0.12, gain: 0.07 }],
  chime: [
    { at: 0, freq: NOTE.C4, ratio: 1, index: 0.5, attack: 0.04, decay: 1.8, gain: 0.05 },
    bell(0, NOTE.C5, 0.08),
    bell(0.09, NOTE.G5, 0.08),
    bell(0.18, NOTE.C6, 0.08),
    bell(0.27, NOTE.E6, 0.09, 1.6),
  ],
  tick: [{ at: 0, freq: 880, ratio: 3.01, index: 1.1, attack: 0.002, decay: 0.05, gain: 0.06 }],
  timeUp: [
    { at: 0, freq: NOTE.G5, ratio: 1, index: 1.4, attack: 0.006, decay: 0.32, gain: 0.1 },
    { at: 0.14, freq: NOTE.C5, ratio: 1, index: 1.4, attack: 0.006, decay: 0.6, gain: 0.1 },
  ],
  real: [bell(0, NOTE.E6, 0.09), bell(0.07, NOTE.B6, 0.06, 1.1)],
  listIn: [{ at: 0, freq: NOTE.E5, ratio: 2, index: 0.6, attack: 0.004, decay: 0.16, gain: 0.06 }],
  place3: [thump(), bell(0.02, NOTE.G5, 0.09)],
  place2: [thump(), bell(0.02, NOTE.B5, 0.09)],
  place1: [
    thump(0, 0.38),
    brass(0, NOTE.C5),
    brass(0.12, NOTE.E5),
    brass(0.24, NOTE.G5),
    brass(0.36, NOTE.C6, 0.1, 0.4),
    brass(0.56, NOTE.C5, 0.06, 1.8),
    brass(0.56, NOTE.E5, 0.06, 1.8),
    brass(0.56, NOTE.G5, 0.06, 1.8),
    brass(0.56, NOTE.C6, 0.07, 1.9),
    bell(0.56, NOTE.D6, 0.05, 1.6),
  ],
};

const MUTED_KEY = 'tp:muted';

let context: AudioContext | null = null;
let output: GainNode | null = null;
let muted = safeStorage.get(MUTED_KEY) === '1';

function audio(): AudioContext | null {
  if (context) return context;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  try {
    context = new Context();
    const compressor = context.createDynamicsCompressor();
    output = context.createGain();
    output.gain.value = 0.8;
    output.connect(compressor).connect(context.destination);
  } catch {
    context = null;
  }
  return context;
}

function playVoice(ctx: AudioContext, out: AudioNode, start: number, voice: Voice): void {
  const t = start + voice.at;
  const end = t + voice.attack + voice.decay;
  const carrier = ctx.createOscillator();
  carrier.frequency.value = voice.freq;
  const modulator = ctx.createOscillator();
  modulator.frequency.value = voice.freq * voice.ratio;
  const depth = ctx.createGain();
  const peak = voice.index * voice.freq * voice.ratio;
  depth.gain.setValueAtTime(peak, t);
  depth.gain.exponentialRampToValueAtTime(Math.max(0.01, peak * 0.08), end);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.linearRampToValueAtTime(voice.gain, t + voice.attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, end);
  modulator.connect(depth).connect(carrier.frequency);
  carrier.connect(amp).connect(out);
  modulator.start(t);
  carrier.start(t);
  modulator.stop(end + 0.05);
  carrier.stop(end + 0.05);
}

let unlocked = false;

/** Browsers keep audio off until someone presses a key or clicks, which the presenter does to start. */
export function unlockSound(): void {
  unlocked = true;
  setMusicMuted(muted);
  startMusic();
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  safeStorage.set(MUTED_KEY, value ? '1' : '0');
  setMusicMuted(value);
}

/** Plays now, or not at all: a sound that arrives late is worse than none. */
export function play(cue: Cue): void {
  if (muted) return;
  const ctx = audio();
  // Audio that's still starting after a key press plays as soon as it can. Without a press it
  // never started, and everything queued would burst out together at the first one.
  if (!ctx || !output || ctx.state === 'closed' || (ctx.state !== 'running' && !unlocked)) return;
  const start = ctx.currentTime + 0.01;
  for (const voice of CUES[cue]) playVoice(ctx, output, start, voice);
  // Lets the browser tests hear what played, without listening to the speakers.
  window.dispatchEvent(new CustomEvent('tp:sound', { detail: cue }));
}
