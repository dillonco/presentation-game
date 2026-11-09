import type { Mood } from '../host/Scene.js';
import akihabara from './scenery/akihabara.jpg';
import asakusa from './scenery/asakusa.jpg';
import cityEvening from './scenery/city-evening.jpg';
import cornerCafe from './scenery/corner-cafe.jpg';
import gardenBridge from './scenery/garden-bridge.jpg';
import kamoRiver from './scenery/kamo-river.jpg';
import neonStreet from './scenery/neon-street.jpg';
import nightBridge from './scenery/night-bridge.jpg';
import osakaCastle from './scenery/osaka-castle.jpg';
import shrineLanterns from './scenery/shrine-lanterns.jpg';

/**
 * Photos from the trip behind the TV, in `client/src/theme/scenery/`. They're served with
 * the app, so they need no outside site. To swap one, drop a JPG in that folder (around
 * 2560px wide, with location data stripped), import it here and put it in a list.
 *
 * Title cards and standings take a different photo for each game, wrapping round. If a
 * photo can't load, the painted sky underneath shows instead.
 */
export const SCENERY: Record<Mood, string[]> = {
  /** The lobby: the city in evening light. */
  dusk: [cityEvening],
  /** Each game's title card: daytime around Japan. */
  day: [asakusa, osakaCastle, kamoRiver, gardenBridge, cornerCafe],
  /** During rounds: dark and calm, so answers read easily. */
  night: [nightBridge],
  /** Standings after each game: city lights. */
  sunset: [neonStreet, akihabara],
  /** The podium: a shrine lit with lanterns. */
  lanterns: [shrineLanterns],
};

/** The photo for this mood, picking a different one for each game where there's a choice. */
export function sceneryFor(mood: Mood, gameNumber = 1): string | null {
  const list = SCENERY[mood];
  if (list.length === 0) return null;
  return list[(Math.max(1, gameNumber) - 1) % list.length]!;
}

export function allSceneryUrls(): string[] {
  return Object.values(SCENERY).flat();
}
