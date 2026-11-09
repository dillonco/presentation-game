/** Deck accent colours, checked so a pale choice can't make the seal or the real answer unreadable. */

const PAPER = '#f5f2ea';
const CHARCOAL = '#1b1c1a';
const READABLE_CONTRAST = 4.5;

export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

export interface AccentColours {
  /** For paper: the phones and the real answer's row. */
  light: string;
  /** For charcoal: the TV. */
  dark: string;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function accentIsReadable(hex: string): boolean {
  return contrastRatio(hex, PAPER) >= READABLE_CONTRAST;
}

/** The deck's colour for paper, and a version lifted toward white until it reads on the TV. */
export function accentColours(hex: string): AccentColours {
  const [r, g, b] = channels(hex);
  let dark = hex.toLowerCase();
  for (let mix = 0.05; mix <= 1 && contrastRatio(dark, CHARCOAL) < READABLE_CONTRAST; mix += 0.05) {
    const lift = (value: number) =>
      Math.round(value + (255 - value) * mix)
        .toString(16)
        .padStart(2, '0');
    dark = `#${lift(r)}${lift(g)}${lift(b)}`;
  }
  return { light: hex.toLowerCase(), dark };
}
