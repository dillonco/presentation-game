import { describe, expect, it } from 'vitest';
import { cleanName, hitsBlocklist, nameKey, nameProblem } from '../../shared/names.js';

describe('line breaks', () => {
  it.each([
    ['Multi\nline\nanswer', 'Multi line answer'],
    ['Windows\r\nline', 'Windows line'],
    ['Tab\tseparated', 'Tab separated'],
    ['Separator\u2028here', 'Separator here'],
    ['  \n  padded \n ', 'padded'],
  ])('keeps words apart in %j', (raw, expected) => {
    expect(cleanName(raw)).toBe(expected);
  });
});

describe('cleanName', () => {
  it.each([
    ['  Alex  ', 'Alex'],
    ['Mary   Ann', 'Mary Ann'],
    ['ＡＬＥＸ', 'ALEX'],
    ['A​lex', 'Alex'],
    ['A‮lex', 'Alex'],
    ['Al\u0000ex', 'Alex'],
    ['ㅤAlex', 'Alex'],
    ['⠀Alex', 'Alex'],
    ['José', 'José'],
  ])('turns %j into %j', (raw, expected) => {
    expect(cleanName(raw)).toBe(expected);
  });

  it('strips stacked accent marks down to a readable amount', () => {
    const zalgo = `Z${'́̂̃̄̅̆'.repeat(5)}oe`;
    // Z, its composed accent, two kept marks, o and e.
    expect(Array.from(cleanName(zalgo).normalize('NFD')).length).toBe(6);
  });
});

describe('nameProblem', () => {
  it.each(['', '   ', '​​', '...', 'ㅤ', '---'])('refuses %j as empty', (raw) => {
    expect(nameProblem(cleanName(raw))).toBe('empty');
  });

  it.each(['Al', '健太', 'Владимир', '🎌', '7'])('accepts %j', (raw) => {
    expect(nameProblem(cleanName(raw))).toBeNull();
  });

  it('counts characters rather than UTF-16 units', () => {
    expect(nameProblem('🎌'.repeat(16))).toBeNull();
    expect(nameProblem('🎌'.repeat(17))).toBe('too_long');
  });
});

describe('nameKey', () => {
  it.each([
    ['Alex', 'ＡＬＥＸ'],
    ['Alex', 'alex'],
    ['Alex', 'Al ex'],
    ['Alex', 'A-l-e-x'],
    ['Alex', 'Àlex'],
    ['Alex', 'Аlex'], // Cyrillic А
    ['Omar', 'οmar'], // Greek ο
  ])('treats %j and %j as the same name', (a, b) => {
    expect(nameKey(cleanName(a))).toBe(nameKey(cleanName(b)));
  });

  it.each([
    ['Alex', 'Alexa'],
    ['健太', '健二'],
    ['🎌', '🗻'],
  ])('keeps %j and %j apart', (a, b) => {
    expect(nameKey(cleanName(a))).not.toBe(nameKey(cleanName(b)));
  });
});

describe('hitsBlocklist', () => {
  it('matches whole words, whatever the capitals or width', () => {
    expect(hitsBlocklist('Big JERK', ['jerk'])).toBe(true);
    expect(hitsBlocklist('ＪＥＲＫ', ['jerk'])).toBe(true);
  });

  it('leaves names that only contain the word', () => {
    expect(hitsBlocklist('Cassie', ['ass'])).toBe(false);
  });

  it('allows everything with an empty list', () => {
    expect(hitsBlocklist('anything', [])).toBe(false);
  });
});
