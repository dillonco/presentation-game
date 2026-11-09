import { useEffect, useRef } from 'react';
import type { WordClip } from '../../../shared/youtube.js';

/**
 * Plays part of a YouTube video, from `clip.start` to `clip.end`, in YouTube's own player.
 * The builder shows the player. The TV hides it and keeps only the sound, since a video's title
 * or picture can give a word's meaning away. It can't take keyboard focus either way, so the
 * presenter's keys keep working.
 */

/** Only what this file uses of YouTube's player API. */
export interface Player {
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getCurrentTime(): number;
  mute(): void;
  unMute(): void;
  /** 0 to 100. */
  setVolume(volume: number): void;
}

interface PlayerApi {
  Player: new (
    frame: HTMLIFrameElement,
    options: { events: { onReady?: () => void; onStateChange?: (event: { data: number }) => void; onError?: () => void } },
  ) => Player;
}

declare global {
  interface Window {
    YT?: PlayerApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_URL = 'https://www.youtube.com/iframe_api';
const PLAYING = 1;
/** How often the end time is checked. Short enough that a clip stops within a syllable. */
const CHECK_MS = 50;
/** A clip that hasn't started by then never will, perhaps because the browser blocked sound. */
const START_WITHIN_MS = 8000;

let api: Promise<PlayerApi> | null = null;

export function loadApi(): Promise<PlayerApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  api ??= new Promise<PlayerApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement('script');
    script.src = API_URL;
    script.async = true;
    script.onerror = () => {
      // Lets a later clip try again, once there's signal.
      api = null;
      script.remove();
      reject(new Error('YouTube could not be reached'));
    };
    document.head.append(script);
  });
  return api;
}

export type ClipState = 'loading' | 'playing' | 'stopped' | 'failed';

export function embedUrl(clip: WordClip, origin: string): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin,
    controls: '0',
    disablekb: '1',
    fs: '0',
    rel: '0',
    playsinline: '1',
    iv_load_policy: '3',
    // Loads the right part of the video first. The exact start comes from seeking.
    start: String(Math.floor(clip.start)),
  });
  return `https://www.youtube-nocookie.com/embed/${clip.video}?${params}`;
}

export function YouTubeClip({ clip, play, muted, title, className, onState }: {
  clip: WordClip;
  /** Each new value plays the clip once from the start. Zero waits. */
  play: number;
  muted: boolean;
  /** Names the player for screen readers. */
  title: string;
  className?: string;
  onState?: (state: ClipState) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const player = useRef<Player | null>(null);
  const ready = useRef(false);
  const wanted = useRef(play);
  const timers = useRef<{ check?: number; giveUp?: number }>({});
  const latest = useRef({ clip, muted, onState });
  latest.current = { clip, muted, onState };

  const stopTimers = () => {
    window.clearInterval(timers.current.check);
    window.clearTimeout(timers.current.giveUp);
  };

  const start = () => {
    const current = player.current;
    if (!current || !ready.current) return;
    const { clip: now, muted: quiet } = latest.current;
    stopTimers();
    if (quiet) current.mute();
    else current.unMute();
    current.seekTo(now.start, true);
    current.playVideo();
    timers.current.giveUp = window.setTimeout(() => {
      stopTimers();
      current.pauseVideo();
      latest.current.onState?.('stopped');
    }, START_WITHIN_MS + (now.end - now.start) * 1000);
    timers.current.check = window.setInterval(() => {
      if (current.getCurrentTime() < latest.current.clip.end) return;
      stopTimers();
      current.pauseVideo();
      latest.current.onState?.('stopped');
    }, CHECK_MS);
  };

  // One player per video. Changing the times only changes what the next play does.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let gone = false;
    ready.current = false;
    latest.current.onState?.('loading');
    loadApi().then(
      (YT) => {
        if (gone) return;
        player.current = new YT.Player(element, {
          events: {
            onReady: () => {
              ready.current = true;
              if (wanted.current > 0) start();
            },
            onStateChange: (event) => {
              if (event.data === PLAYING) latest.current.onState?.('playing');
            },
            onError: () => {
              stopTimers();
              latest.current.onState?.('failed');
            },
          },
        });
      },
      () => {
        if (!gone) latest.current.onState?.('failed');
      },
    );
    return () => {
      gone = true;
      stopTimers();
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.video]);

  useEffect(() => {
    wanted.current = play;
    if (play > 0) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);

  useEffect(() => {
    if (!ready.current || !player.current) return;
    if (muted) player.current.mute();
    else player.current.unMute();
  }, [muted]);

  return (
    <iframe
      key={clip.video}
      ref={frame}
      className={className}
      src={embedUrl(clip, window.location.origin)}
      title={title}
      allow="autoplay; encrypted-media"
      // The app sends no referrer anywhere, but YouTube's player refuses to load without one.
      // Only this site's address goes, never the room's.
      referrerPolicy="strict-origin-when-cross-origin"
      tabIndex={-1}
    />
  );
}
