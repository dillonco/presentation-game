/**
 * Define it can play a short YouTube clip of someone saying the word. The deck keeps the link
 * as pasted, plus when the clip starts and ends, so a half-typed link is never lost.
 */

export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
/** Long enough to say a phrase twice. A clip is there to hear the word, not to watch a video. */
export const MAX_CLIP_SECONDS = 20;
/** Times are kept to a tenth of a second, which is as close as anyone can hear. */
export const CLIP_STEP = 0.1;
/** Twelve hours, comfortably past any real video. */
export const MAX_CLIP_TIME = 12 * 60 * 60;
/** Where a new clip ends when only its start is known: about one word, said once. */
export const DEFAULT_CLIP_SECONDS = 3;

/** What the TV needs to play a clip. */
export interface WordClip {
  video: string;
  start: number;
  end: number;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/**
 * Reads a YouTube link from any of the ways YouTube shares one, including a `t=` start time.
 * Anything else gives null, so only YouTube ever plays on the TV.
 */
export function parseYouTubeLink(text: string): { video: string; start: number | null } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  let video: string | undefined;
  if (host === 'youtu.be') {
    video = url.pathname.split('/')[1];
  } else if (YOUTUBE_HOSTS.has(host)) {
    const [, first, second] = url.pathname.split('/');
    if (first === 'watch') video = url.searchParams.get('v') ?? undefined;
    else if (first === 'shorts' || first === 'embed' || first === 'live' || first === 'v') video = second;
  }
  if (!video || !YOUTUBE_ID_PATTERN.test(video)) return null;
  const t = url.searchParams.get('t') ?? url.searchParams.get('start');
  return { video, start: t === null ? null : parseLinkTime(t) };
}

/** YouTube's own `t=` forms: `75`, `75s` or `1m15s`. */
function parseLinkTime(text: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(text);
  if (!match || text === '') return null;
  const [, hours = '0', minutes = '0', seconds = '0'] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total <= MAX_CLIP_TIME ? total : null;
}

export function roundClipTime(seconds: number): number {
  // Multiplying by ten rather than dividing by the step keeps 1.2 from becoming 1.2000000000000002.
  return Math.round(seconds * 10) / 10;
}

/** A time as someone would type it from the YouTube player: `75`, `1:15`, `1:15.5` or `1:01:15`. */
export function parseClipTime(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((part) => part === '')) return null;
  const last = parts.pop()!;
  if (!/^\d+(\.\d+)?$/.test(last) || !parts.every((part) => /^\d+$/.test(part))) return null;
  const seconds = Number(last);
  // After a colon, seconds stop at 59 like on any clock.
  if (parts.length > 0 && seconds >= 60) return null;
  if (parts.length === 2 && Number(parts[1]) >= 60) return null;
  const total = parts.reduce((sum, part) => sum * 60 + Number(part), 0) * 60 + seconds;
  return total <= MAX_CLIP_TIME ? roundClipTime(total) : null;
}

/** The way the builder shows a time back: `1:15.5`, or `0:08`. */
export function formatClipTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, '0');
  const tail = fraction ? `${secs}.${fraction}` : secs;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}
