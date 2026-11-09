import type { GameType, RoundInfo } from '../../../shared/protocol.js';

export const GAME_NUMERALS = ['壱', '弐', '参', '肆'];

export const GAME_NAMES: Record<GameType, string> = {
  define: 'Define it',
  geo: 'Where was this?',
  caption: 'Caption this',
  choice: 'Pick one',
};

export const GAME_RULES: Record<GameType, string> = {
  define: 'Write a convincing fake definition, then find the real one.',
  geo: 'Drop a pin on the map. The closer you are, the more you score.',
  caption: 'Write the best caption, then vote for your favourite.',
  choice: 'Look at the photo and pick the right answer of the four.',
};

/** "Word 2 of 5", or "Photo 2 of 5". */
export function roundPosition(round: RoundInfo): string {
  return `${round.image === null ? 'Word' : 'Photo'} ${round.number} of ${round.count}`;
}

/** What guests are writing in this round. */
export function answerName(round: RoundInfo): 'Definition' | 'Caption' {
  return round.image === null ? 'Definition' : 'Caption';
}

/** What to call this round on its own: the word itself, or which photo it is. */
export function roundName(round: RoundInfo): string {
  return round.prompt || roundPosition(round);
}

export function formatKm(km: number): string {
  if (km < 1) return 'Under 1 km';
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en')} km`;
}

export function mediaUrl(image: string, size: 'full' | 'small'): string {
  return `/media/${image}/${size}.jpg`;
}

export function videoUrl(video: string): string {
  return `/media/${video}/video.mp4`;
}

export function ordinal(rank: number): string {
  const tens = rank % 100;
  if (tens >= 11 && tens <= 13) return `${rank}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][rank % 10] ?? 'th';
  return `${rank}${suffix}`;
}
