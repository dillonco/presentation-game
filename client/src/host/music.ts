import { loadApi, type Player } from '../ui/YouTubeClip.js';

/**
 * Background music for the whole night: a YouTube video, looping quietly in a hidden player
 * on the TV. It starts at the presenter's first key press or click (browsers keep sound off
 * until then), stops with M, and waits while a word clip plays so the two don't clash.
 */

/**
 * "Miracle Shopping", the Don Quijote store song, from its writer and singer Maimi Tanaka's
 * own channel. Swap in any video's ID (the part after `watch?v=`), or '' for no music.
 * Her bossa nova version is 'q4mzRzPtCNw'.
 */
export const MUSIC_VIDEO = 'lUsJsealYxM';
/** YouTube's 0–100 scale. Low, so it sits under the cues and the room's talking. */
const MUSIC_VOLUME = 12;
const ENDED = 0;

let created = false;
let player: Player | null = null;
let ready = false;
let wanted = false;
let muted = false;
let clipPlaying = false;

function apply(): void {
  if (!player || !ready) return;
  if (wanted && !muted && !clipPlaying) player.playVideo();
  else player.pauseVideo();
}

function embedUrl(video: string): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin: window.location.origin,
    controls: '0',
    disablekb: '1',
    fs: '0',
    rel: '0',
    playsinline: '1',
    iv_load_policy: '3',
    // Plays the video again when it ends. YouTube loops only a playlist, so it's a list of one.
    loop: '1',
    playlist: video,
  });
  return `https://www.youtube-nocookie.com/embed/${video}?${params}`;
}

function create(): void {
  created = true;
  const holder = document.createElement('div');
  holder.className = 'tv-music';
  holder.setAttribute('aria-hidden', 'true');
  const frame = document.createElement('iframe');
  frame.src = embedUrl(MUSIC_VIDEO);
  frame.title = 'Background music';
  frame.allow = 'autoplay; encrypted-media';
  // The app sends no referrer anywhere, but YouTube's player refuses to load without one.
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  // The presenter's keys must keep working.
  frame.tabIndex = -1;
  holder.append(frame);
  document.body.append(holder);
  loadApi().then(
    (YT) => {
      const made = new YT.Player(frame, {
        events: {
          onReady: () => {
            ready = true;
            made.setVolume(MUSIC_VOLUME);
            made.unMute();
            apply();
          },
          onStateChange: (event) => {
            // In case the loop setting is ignored, starts it again by hand.
            if (event.data === ENDED && wanted && !muted && !clipPlaying) {
              made.seekTo(0, true);
              made.playVideo();
            }
          },
        },
      });
      player = made;
    },
    () => {
      // No signal: the next key press tries again.
      holder.remove();
      created = false;
    },
  );
}

/** Called on every key press and click, since any of them may be the one that unlocks sound. */
export function startMusic(): void {
  if (!MUSIC_VIDEO) return;
  wanted = true;
  if (!created) create();
  else apply();
}

export function setMusicMuted(value: boolean): void {
  muted = value;
  apply();
}

/** A word clip is playing, or about to play again, so the music waits. */
export function setClipPlaying(value: boolean): void {
  if (clipPlaying === value) return;
  clipPlaying = value;
  apply();
}
