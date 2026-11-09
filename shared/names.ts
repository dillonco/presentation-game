import { MAX_ANSWER_LENGTH, MAX_NAME_LENGTH } from './constants.js';

// Characters that draw nothing but aren't classed as format characters by Unicode.
const BLANK_LOOKALIKES = /[ᅟᅠ឴឵᠎⠀ㅤﾠ]/gu;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
// Some scripts need two marks on a letter. Anything beyond that is layout-breaking "zalgo" text.
const STACKED_MARKS = /(\p{M}{2})\p{M}+/gu;
const VISIBLE_CONTENT = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/** Latin look-alikes from other alphabets, so "Аlex" with a Cyrillic А can't pose as "Alex". */
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};

export type NameProblem = 'empty' | 'too_long';

/** The version of a name that gets stored and displayed. */
export function cleanName(raw: string): string {
  return raw
    .normalize('NFKC')
    // Before invisible characters go, or pasted lines would run together with no space.
    .replace(/[\r\n\t\u2028\u2029]+/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(BLANK_LOOKALIKES, '')
    .normalize('NFC')
    .replace(STACKED_MARKS, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function nameProblem(cleaned: string): NameProblem | null {
  if (!VISIBLE_CONTENT.test(cleaned)) return 'empty';
  // Counts characters rather than UTF-16 units, so an emoji counts once.
  if (Array.from(cleaned).length > MAX_NAME_LENGTH) return 'too_long';
  return null;
}

export function answerProblem(cleaned: string): NameProblem | null {
  if (!VISIBLE_CONTENT.test(cleaned)) return 'empty';
  if (Array.from(cleaned).length > MAX_ANSWER_LENGTH) return 'too_long';
  return null;
}

/** Two names with the same key count as the same name: "Alex", "ＡＬＥＸ" and "Al-ex" all match. */
export function nameKey(cleaned: string): string {
  const folded = cleaned.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
  let key = '';
  for (const character of folded) {
    const mapped = CONFUSABLES[character] ?? character;
    if (/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(mapped)) key += mapped;
  }
  return key;
}

/** Whole words only, so a blocked "ass" doesn't catch "Cassie". */
export function hitsBlocklist(cleaned: string, blocklist: readonly string[]): boolean {
  if (blocklist.length === 0) return false;
  const blocked = new Set(blocklist.map((word) => nameKey(cleanName(word))).filter(Boolean));
  const words = cleaned.split(/[^\p{L}\p{N}]+/u).map(nameKey).filter(Boolean);
  return blocked.has(nameKey(cleaned)) || words.some((word) => blocked.has(word));
}
