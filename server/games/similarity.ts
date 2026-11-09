/**
 * Decides whether two answers are too alike, by wording only. It runs on the server,
 * so it can't be skipped, and its verdict never says what an answer matched.
 */

export type Strictness = 'loose' | 'normal' | 'strict';

const LIMITS: Record<Strictness, { overlap: number; minWords: number }> = {
  loose: { overlap: 0.9, minWords: 4 },
  normal: { overlap: 0.75, minWords: 3 },
  strict: { overlap: 0.6, minWords: 2 },
};

const SMALL_WORDS = new Set(
  (
    'a an the of to in on at by for from with and or but as is are was were be been it its this that these those ' +
    'you your when where which who what how through into onto over under very really just kind type sort'
  ).split(' '),
);

/** Common English endings only. It needn't be perfect, just consistent on both sides. */
function stem(word: string): string {
  let result = word;
  if (result.length > 5 && result.endsWith('ing')) result = result.slice(0, -3);
  else if (result.length > 4 && result.endsWith('ed')) result = result.slice(0, -2);
  else if (result.length > 4 && result.endsWith('ly')) result = result.slice(0, -2);
  else if (result.length > 4 && result.endsWith('es')) result = result.slice(0, -2);
  else if (result.length > 3 && result.endsWith('s') && !result.endsWith('ss')) result = result.slice(0, -1);
  // "running" becomes "runn" above, and "tree" must match "trees".
  if (result.length > 3 && result.at(-1) === result.at(-2)) result = result.slice(0, -1);
  if (result.length > 3 && result.endsWith('e')) result = result.slice(0, -1);
  return result;
}

function tokens(text: string): string[] {
  const folded = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '');
  return folded.match(/[\p{L}\p{N}\p{Extended_Pictographic}]+/gu) ?? [];
}

/** The meaningful words of an answer. An answer of only small words keeps them. */
export function meaningfulWords(text: string): string[] {
  const all = tokens(text);
  const content = all.filter((word) => !SMALL_WORDS.has(word));
  return (content.length > 0 ? content : all).map(stem);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Short words must match exactly, so "fish" and "dish" stay different. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (longest < 5) return false;
  return editDistance(a, b) <= (longest >= 8 ? 2 : 1);
}

function sharedWords(a: string[], b: string[]): number {
  const unused = [...b];
  let shared = 0;
  for (const word of a) {
    const match = unused.findIndex((other) => sameWord(word, other));
    if (match !== -1) {
      unused.splice(match, 1);
      shared += 1;
    }
  }
  return shared;
}

export function tooSimilar(first: string, second: string, strictness: Strictness = 'normal'): boolean {
  const a = meaningfulWords(first);
  const b = meaningfulWords(second);
  if (a.length === 0 || b.length === 0) return false;

  // The same after cleanup, including "sun light" against "sunlight".
  if (a.join('') === b.join('')) return true;

  // The same words in the same order, apart from small spelling changes.
  if (a.length === b.length && a.every((word, index) => sameWord(word, b[index]!))) return true;

  const { overlap, minWords } = LIMITS[strictness];
  const shortest = Math.min(a.length, b.length);
  const shared = sharedWords(a, b);

  // A trimmed-down copy: "sunlight through the leaves" against the full definition. One
  // word isn't enough, so "a type of fish" doesn't block every other answer about fish.
  if (strictness !== 'loose' && shortest >= 2 && shared === shortest) return true;

  // Shares most of its meaningful words. Very short answers never get this far.
  if (shortest < minWords) return false;
  return shared / shortest >= overlap && shared / Math.max(a.length, b.length) >= overlap - 0.2;
}
