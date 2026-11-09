import { describe, expect, it } from 'vitest';
import { tooSimilar } from '../../server/games/similarity.js';

describe('answers that must be flagged', () => {
  it.each([
    ['Sunlight filtering through trees', 'sunlight filtering through trees'],
    ['Sunlight filtering through trees', 'Sunlight, filtering through the trees!'],
    ['Sunlight filtering through trees', 'ＳＵＮＬＩＧＨＴ filtering through trees'],
    ['Sunlight filtering through trees', 'Sunlight filtered through a tree'],
    ['Sunlight filtering through trees', 'Sun light filtering through trees'],
    ['Sunlight filtering through trees', 'Sunlite filtering through trees'],
    ['Sunlight filtering through trees', 'Trees filtering sunlight'],
    ['Sunlight filtering through the leaves of trees', 'Sunlight filtering through leaves'],
    ['A café in Kyoto', 'a cafe in kyoto'],
    ['Eating until you fall over', 'eating until you fall over.'],
    ['walking in the rain at night', 'A walk in the rain at night'],
    ['the the', 'The the!'],
    ['a type of fish', 'a kind of fish'],
    ['Sunlight filtering through the leaves of trees', 'Sunlight through the leaves'],
    ['A bowl of cold noodles eaten alone', 'Cold noodles'],
  ])('%s / %s', (a, b) => {
    expect(tooSimilar(a, b)).toBe(true);
    expect(tooSimilar(b, a)).toBe(true);
  });
});

describe('answers that must pass', () => {
  it.each([
    ['a type of fish', 'a type of bird'],
    ['a type of fish', 'a kind of dish'],
    ['a type of fish', 'a small river fish'],
    ['fish', 'dish'],
    ['Sunlight filtering through trees', 'Light coming through the leaves'],
    ['A shared meal after the first snowfall', 'The sound of rain on a paper umbrella'],
    ['A small cat', 'A small hat'],
    ['An old temple bell', 'An old train station'],
    ['Eating too much', 'Buying too many books'],
    ['Buying books and leaving them unread', 'Leaving your shoes outside the door'],
    ['🍣', '🍜'],
  ])('%s / %s', (a, b) => {
    expect(tooSimilar(a, b)).toBe(false);
    expect(tooSimilar(b, a)).toBe(false);
  });
});

describe('strictness', () => {
  const a = 'Quiet walk near a mountain shrine';
  const b = 'Quiet walk near the old forest';

  it('changes how much overlap is too much', () => {
    expect(tooSimilar(a, b, 'loose')).toBe(false);
    expect(tooSimilar(a, b, 'normal')).toBe(false);
    expect(tooSimilar(a, b, 'strict')).toBe(true);
  });

  it('always flags identical answers', () => {
    for (const strictness of ['loose', 'normal', 'strict'] as const) {
      expect(tooSimilar('Quiet walk', 'quiet walks', strictness)).toBe(true);
    }
  });
});

it('ignores answers with nothing in them', () => {
  expect(tooSimilar('...', '...')).toBe(false);
  expect(tooSimilar('', 'fish')).toBe(false);
});
