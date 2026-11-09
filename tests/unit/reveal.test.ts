import { describe, expect, it } from 'vitest';
import { revealRowTimes, showcaseMs } from '../../shared/reveal.js';

function rows(quiet: number, voted: number, real = true) {
  return [
    ...Array.from({ length: quiet }, () => ({ votes: 0, real: false })),
    ...Array.from({ length: voted }, () => ({ votes: 2, real: false })),
    ...(real ? [{ votes: 3, real: true }] : []),
  ];
}

describe('reveal pacing', () => {
  it('starts straight away and only moves forward', () => {
    const times = revealRowTimes(rows(4, 3));
    expect(times[0]).toBe(0);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThan(times[index - 1]!);
    }
  });

  it('holds longest before the real answer', () => {
    const times = revealRowTimes(rows(2, 2));
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(gaps.at(-1)).toBe(Math.max(...gaps));
  });

  it('spends longer on answers people actually chose', () => {
    const times = revealRowTimes(rows(3, 3));
    expect(times[1]! - times[0]!).toBeLessThan(times[4]! - times[3]!);
  });

  it.each([
    [12, 8, 3],
    [50, 40, 9],
    [50, 0, 49],
    [50, 49, 0],
  ])('keeps a room of %i under 20 seconds', (_room, quiet, voted) => {
    expect(revealRowTimes(rows(quiet, voted)).at(-1)!).toBeLessThanOrEqual(20_000);
  });

  it('handles an empty round and a caption round with no real answer', () => {
    expect(revealRowTimes([])).toEqual([]);
    expect(revealRowTimes([{ votes: 0, real: true }])).toEqual([0]);
    expect(revealRowTimes(rows(1, 2, false))).toHaveLength(3);
  });

  it('pauses once before the top caption, even when several tie for it', () => {
    const times = revealRowTimes([
      { votes: 0, real: false, top: false },
      { votes: 1, real: false, top: false },
      { votes: 3, real: false, top: true },
      { votes: 3, real: false, top: true },
    ]);
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(gaps[1]).toBeGreaterThan(gaps[2]!);
    expect(gaps[1]).toBe(1800);
  });
});

describe('how long each caption is shown', () => {
  it('gives a longer caption more time, within limits', () => {
    const short = showcaseMs('Nice hat', 5);
    const long = showcaseMs('x'.repeat(140), 5);
    expect(short).toBeGreaterThanOrEqual(4000);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(10_000);
  });

  it('keeps a full room to about two minutes a photo, without becoming unreadable', () => {
    const each = showcaseMs('x'.repeat(140), 50);
    expect(each).toBe(2500);
    expect(each * 50).toBeLessThanOrEqual(130_000);
    expect(showcaseMs('x'.repeat(140), 20)).toBe(6000);
  });

  it('uses a time set in the deck, whatever the length or the room', () => {
    expect(showcaseMs('x'.repeat(140), 50, 7000)).toBe(7000);
  });
});
