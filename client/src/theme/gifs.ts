/**
 * Funny GIFs for the in-between screens on the TV: one on each game's title card and one on
 * the standings after it. Swap any line for another Giphy GIF by its id (the part of the
 * Giphy link after the last dash, e.g. giphy.com/gifs/totoro-jvUjIiKFPdte → jvUjIiKFPdte).
 * If a GIF can't load, its card just doesn't appear.
 */
export interface Gif {
  id: string;
  /** Read out by screen readers. */
  alt: string;
  /** The joke, written under the GIF like a photo caption. */
  caption: string;
}

/** Shown on each game's title card, in order, wrapping round if the deck has more games. */
export const TITLE_GIFS: Gif[] = [
  { id: 'KEVODnr6kaJws', alt: 'The Catbus grinning from ear to ear', caption: 'All aboard. Next stop: chaos.' },
  { id: 'Q9NrmGiBbsvfO', alt: 'Ponyo sprinting across the tops of the waves', caption: 'Me, sprinting into the next game' },
  { id: '11xOhngUw9vipi', alt: 'Calcifer the fire demon flickering', caption: 'Things are about to heat up' },
  { id: 'jvUjIiKFPdte', alt: 'Totoro opening his mouth in an enormous roar', caption: 'Summoning every last brain cell' },
  { id: '4TmLKfeYOuO2c', alt: 'A crowd of soot sprites scattering', caption: 'Everyone scrambling for their phones' },
  { id: '11D0XkJInM2ssU', alt: 'Satsuki and Totoro waiting at a bus stop in the rain', caption: 'Waiting for the slow typers like' },
];

/** Shown beside the standings after each game, in order. */
export const STANDINGS_GIFS: Gif[] = [
  { id: 'qTCKtDMh9wS9a', alt: 'Howl looking utterly shocked', caption: 'Checking the scores like' },
  { id: 'HR3SoNfx2LdVS', alt: 'A dad and his two daughters laughing in the bath', caption: 'Whoever is in first right now' },
  { id: 'iBbS92c4m2dObVdBPp', alt: 'A boy staring sadly at the ground', caption: 'When nobody voted for your answer' },
  { id: '1miiQ53ITadPAIkH7N', alt: 'The radish spirit standing awkwardly in a lift', caption: 'Pretending I’m fine with 4th place' },
  { id: 'AebNPktTHrdYc', alt: 'Mei asleep on Totoro’s tummy', caption: 'Me after one more round' },
  { id: 'GuLxAZW23YZwY', alt: 'Someone lying face down on the floor', caption: 'Whoever is in last right now' },
];

/** Picks one per game, so each game gets a different GIF. */
export function gifFor(list: readonly Gif[], gameNumber: number): Gif | null {
  if (list.length === 0) return null;
  return list[(Math.max(1, gameNumber) - 1) % list.length]!;
}

/** The webp is about half the size of the GIF; the GIF is the fallback for older browsers. */
export function gifUrls(gif: Gif): { webp: string; gif: string } {
  const base = `https://media.giphy.com/media/${encodeURIComponent(gif.id)}`;
  return { webp: `${base}/giphy.webp`, gif: `${base}/giphy.gif` };
}
