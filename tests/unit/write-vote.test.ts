import { describe, expect, it } from 'vitest';
import { MAX_FLAGGED_TRIES } from '../../shared/constants.js';
import {
  DEFAULT_POINTS,
  FLAGGED_WAIT_MS,
  scoreRound,
  WriteVoteRound,
  type RoundConfig,
} from '../../server/games/write-vote.js';

const REAL = 'Sunlight filtering through the leaves of trees';

function defineRound(overrides: Partial<RoundConfig> = {}): WriteVoteRound {
  return new WriteVoteRound({
    game: 'define',
    prompt: 'komorebi',
    realAnswer: REAL,
    writeMs: 60_000,
    voteMs: 45_000,
    points: DEFAULT_POINTS,
    similarity: 'normal',
    blocklist: [],
    ...overrides,
  });
}

function captionRound(): WriteVoteRound {
  return defineRound({ game: 'caption', realAnswer: null });
}

function realEntryId(round: WriteVoteRound): string {
  return round.allEntries().find((entry) => entry.text === REAL)!.id;
}

function entryIdOf(round: WriteVoteRound, text: string): string {
  return round.allEntries().find((entry) => entry.text === text)!.id;
}

describe('points', () => {
  const entries = [
    { id: 'real', authorId: null },
    { id: 'a', authorId: 'alex' },
    { id: 'b', authorId: 'sam' },
  ];

  it('gives 1000 for finding the real answer and 500 per person fooled', () => {
    const results = scoreRound(
      { points: DEFAULT_POINTS, realAnswer: REAL },
      entries,
      new Map([
        ['alex', 'real'],
        ['sam', 'a'],
        ['priya', 'a'],
      ]),
    );
    expect(results.get('alex')).toEqual({ foundReal: true, votes: 2, points: 2000 });
    expect(results.get('sam')).toEqual(undefined);
  });

  it('caps the points for fooling people at 1500 per word', () => {
    const votes = new Map(['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => [id, 'a']));
    const results = scoreRound({ points: DEFAULT_POINTS, realAnswer: REAL }, entries, votes);
    expect(results.get('alex')).toEqual({ foundReal: false, votes: 5, points: 1500 });
  });

  it('never scores a vote for your own entry, even if one somehow exists', () => {
    const results = scoreRound({ points: DEFAULT_POINTS, realAnswer: REAL }, entries, new Map([['alex', 'a']]));
    expect(results.get('alex')).toBeUndefined();
  });

  it('gives captions 200 per vote plus 500 for the top one, and ties both get it', () => {
    const results = scoreRound(
      { points: DEFAULT_POINTS, realAnswer: null },
      entries,
      new Map([
        ['p1', 'a'],
        ['p2', 'a'],
        ['p3', 'b'],
        ['p4', 'b'],
      ]),
    );
    expect(results.get('alex')!.points).toBe(900);
    expect(results.get('sam')!.points).toBe(900);
  });

  it('caps the points for caption votes at 1500, before the top bonus', () => {
    const votes = new Map(Array.from({ length: 20 }, (_, index) => [`p${index}`, 'a']));
    const results = scoreRound({ points: DEFAULT_POINTS, realAnswer: null }, entries, votes);
    expect(results.get('alex')!.points).toBe(2000);
  });

  it('uses the point values the deck sets', () => {
    const points = { ...DEFAULT_POINTS, findReal: 7, perFooled: 3 };
    const results = scoreRound(
      { points, realAnswer: REAL },
      entries,
      new Map([
        ['alex', 'real'],
        ['sam', 'a'],
      ]),
    );
    expect(results.get('alex')!.points).toBe(10);
  });
});

describe('writing', () => {
  it('flags the real answer and another guest with the identical reply', () => {
    const round = defineRound();
    round.submitAnswer('alex', 'A quiet walk at dawn', 0);
    const real = round.submitAnswer('sam', 'sunlight filtering through leaves', 0);
    const player = round.submitAnswer('priya', 'a quiet walk at dawn!', 0);
    expect(real).toEqual({ ok: false, code: 'too_similar' });
    expect(player).toEqual(real);
  });

  it('lets a guest edit, ignoring their own earlier version', () => {
    const round = defineRound();
    round.submitAnswer('alex', 'A quiet walk at dawn', 0);
    expect(round.submitAnswer('alex', 'A quiet walk at dusk', 1)).toEqual({ ok: true });
    expect(round.answerOf('alex')).toBe('A quiet walk at dusk');
  });

  it('keeps the previous version when an edit is flagged', () => {
    const round = defineRound();
    round.submitAnswer('alex', 'A quiet walk at dawn', 0);
    expect(round.submitAnswer('alex', REAL, 1).ok).toBe(false);
    expect(round.answerOf('alex')).toBe('A quiet walk at dawn');
  });

  it('makes a guest wait between flagged tries, without using up a try', () => {
    const round = defineRound();
    round.submitAnswer('alex', REAL, 0);
    expect(round.submitAnswer('alex', REAL, FLAGGED_WAIT_MS - 1)).toEqual({ ok: false, code: 'too_soon' });
    expect(round.triesLeft('alex')).toBe(MAX_FLAGGED_TRIES - 1);
  });

  it('stops after 5 flagged tries, and that guest no longer holds up the round', () => {
    const round = defineRound();
    let now = 0;
    for (let tries = 0; tries < MAX_FLAGGED_TRIES; tries += 1) {
      expect(round.submitAnswer('alex', REAL, now)).toEqual({ ok: false, code: 'too_similar' });
      now += FLAGGED_WAIT_MS;
    }
    expect(round.submitAnswer('alex', 'Something else entirely', now)).toEqual({ ok: false, code: 'no_more_tries' });
    expect(round.answerOf('alex')).toBeNull();
    expect(round.doneWriting('alex')).toBe(true);
    round.startVote();
    expect(round.vote('alex', realEntryId(round))).toEqual({ ok: true });
  });

  it('refuses empty, overlong and blocked answers, without using up a try', () => {
    const round = defineRound({ blocklist: ['jerk'] });
    expect(round.submitAnswer('alex', '  ​ ', 0)).toEqual({ ok: false, code: 'answer_empty' });
    expect(round.submitAnswer('alex', 'x'.repeat(141), 0)).toEqual({ ok: false, code: 'answer_too_long' });
    expect(round.submitAnswer('alex', 'What a jerk', 0)).toEqual({ ok: false, code: 'answer_blocked' });
    expect(round.triesLeft('alex')).toBe(MAX_FLAGGED_TRIES);
  });

  it('strips invisible characters and stacked accents', () => {
    const round = defineRound();
    round.submitAnswer('alex', 'A qu\u200Biet wa\u0301\u0301\u0301\u0301lk', 0);
    // The first accent joins its letter, and two more stay because some scripts need them.
    expect(round.answerOf('alex')).toBe('A quiet w\u00E1\u0301\u0301lk');
  });
});

describe('voting', () => {
  function votingRound(): WriteVoteRound {
    const round = defineRound();
    round.submitAnswer('alex', 'A quiet walk at dawn', 0);
    round.submitAnswer('sam', 'The sound of rain on paper', 0);
    round.startVote();
    return round;
  }

  it('leaves a guest\'s own entry off their ballot and refuses it if sent anyway', () => {
    const round = votingRound();
    const own = entryIdOf(round, 'A quiet walk at dawn');
    expect(round.ballotFor('alex').map((entry) => entry.id)).not.toContain(own);
    expect(round.vote('alex', own)).toEqual({ ok: false, code: 'own_entry' });
    expect(round.voteOf('alex')).toBeNull();
  });

  it('keeps each guest\'s order stable, and gives different guests their own', () => {
    const round = defineRound();
    for (let index = 0; index < 12; index += 1) round.submitAnswer(`p${index}`, `word${index}x${index} unique${index}`, 0);
    round.startVote();
    const first = round.ballotFor('guest-a').map((entry) => entry.id);
    expect(round.ballotFor('guest-a').map((entry) => entry.id)).toEqual(first);
    expect(round.ballotFor('guest-b').map((entry) => entry.id)).not.toEqual(first);
  });

  it('counts only the latest vote', () => {
    const round = votingRound();
    round.vote('priya', entryIdOf(round, 'A quiet walk at dawn'));
    round.vote('priya', realEntryId(round));
    const results = round.resolve();
    expect(results.get('priya')).toEqual({ foundReal: true, votes: 0, points: 1000 });
    expect(results.get('alex')).toBeUndefined();
  });

  it('refuses a vote for something not on the ballot', () => {
    expect(votingRound().vote('priya', 'made-up')).toEqual({ ok: false, code: 'not_found' });
  });

  it('adds 3 seconds per entry past 8', () => {
    const round = defineRound();
    for (let index = 0; index < 10; index += 1) round.submitAnswer(`p${index}`, `word${index}x${index} unique${index}`, 0);
    round.startVote();
    expect(round.voteMs()).toBe(45_000 + 3 * 3000);
  });

  it('lets voters choose again when a hidden answer disappears', () => {
    const round = votingRound();
    const hidden = entryIdOf(round, 'A quiet walk at dawn');
    round.vote('priya', hidden);
    expect(round.hide(hidden)).toEqual({ ok: true });
    expect(round.voteOf('priya')).toBeNull();
    expect(round.voteWasCleared('priya')).toBe(true);
    expect(round.ballotFor('priya').map((entry) => entry.id)).not.toContain(hidden);
    round.vote('priya', realEntryId(round));
    expect(round.voteWasCleared('priya')).toBe(false);
  });

  it('refuses to hide the real answer', () => {
    const round = votingRound();
    expect(round.hide(realEntryId(round))).toEqual({ ok: false, code: 'cannot_hide' });
  });

  it('gives a hidden entry\'s author no points', () => {
    const round = votingRound();
    const hidden = entryIdOf(round, 'A quiet walk at dawn');
    round.vote('priya', hidden);
    round.hide(hidden);
    expect(round.resolve().get('alex')).toBeUndefined();
  });

  it('removes a removed player\'s entry and vote before the reveal', () => {
    const round = votingRound();
    const theirs = entryIdOf(round, 'A quiet walk at dawn');
    round.vote('priya', theirs);
    round.vote('alex', entryIdOf(round, 'The sound of rain on paper'));
    round.removePlayer('alex');
    expect(round.allEntries().map((entry) => entry.id)).not.toContain(theirs);
    expect(round.voteWasCleared('priya')).toBe(true);
    expect(round.resolve().get('sam')).toBeUndefined();
  });

  it('only blanks an answer after the reveal, leaving the points alone', () => {
    const round = votingRound();
    const entryId = entryIdOf(round, 'A quiet walk at dawn');
    round.vote('priya', entryId);
    round.resolve();
    expect(round.hide(entryId)).toEqual({ ok: true });
    const row = round.revealRows(() => 'Alex').find((candidate) => candidate.id === entryId)!;
    expect(row).toMatchObject({ masked: true, text: '', votes: 1 });
    expect(round.resultOf('alex').points).toBe(500);
  });
});

describe('repeats and old messages', () => {
  it('returns the original result for a repeat, and changes nothing', () => {
    const round = defineRound();
    let runs = 0;
    const action = () => {
      runs += 1;
      return { ok: false as const, code: 'too_similar' as const };
    };
    expect(round.act('write', 'alex', 1, action)).toEqual({ ok: false, code: 'too_similar' });
    expect(round.act('write', 'alex', 1, action)).toEqual({ ok: false, code: 'too_similar' });
    expect(runs).toBe(1);
  });

  it('ignores an old message that arrives after a newer one', () => {
    const round = defineRound();
    round.act('write', 'alex', 5, () => round.submitAnswer('alex', 'The newer answer', 0));
    const late = round.act('write', 'alex', 4, () => round.submitAnswer('alex', 'The older answer', 0));
    expect(late).toEqual({ ok: false, code: 'stale_action' });
    expect(round.answerOf('alex')).toBe('The newer answer');
  });

  it('keeps writing and voting numbers apart', () => {
    const round = defineRound();
    round.act('write', 'alex', 9, () => ({ ok: true }));
    expect(round.act('vote', 'alex', 1, () => ({ ok: true }))).toEqual({ ok: true });
  });
});

describe('results', () => {
  it('builds the reveal from least voted to most voted, with the real answer last', () => {
    const round = defineRound();
    round.submitAnswer('alex', 'A quiet walk at dawn', 0);
    round.submitAnswer('sam', 'The sound of rain on paper', 0);
    round.startVote();
    round.vote('priya', entryIdOf(round, 'The sound of rain on paper'));
    round.vote('jo', entryIdOf(round, 'The sound of rain on paper'));
    round.resolve();
    const rows = round.revealRows((id) => id);
    expect(rows.map((row) => row.text)).toEqual(['A quiet walk at dawn', 'The sound of rain on paper', REAL]);
    expect(rows[2]).toMatchObject({ real: true, author: null, votes: 0 });
    expect(rows[1]).toMatchObject({ real: false, author: 'sam', votes: 2 });
  });

  it('scores once, however many times it is asked', () => {
    const round = defineRound();
    round.startVote();
    round.vote('alex', realEntryId(round));
    const first = round.resolve();
    expect(round.resolve()).toBe(first);
  });

  it('survives being saved and restored, including who wrote what', () => {
    const round = defineRound();
    round.submitAnswer('alex', 'A quiet walk at dawn', 0);
    round.startVote();
    round.vote('sam', entryIdOf(round, 'A quiet walk at dawn'));
    const state = WriteVoteRound.parseState(JSON.parse(JSON.stringify(round.toState())))!;
    const restored = new WriteVoteRound(round.config, state);
    expect(restored.ballotFor('sam')).toEqual(round.ballotFor('sam'));
    expect(restored.voteOf('sam')).toBe(round.voteOf('sam'));
    expect(restored.resolve().get('alex')!.points).toBe(500);
  });
});

describe('Caption this uses the same engine', () => {
  it('has nothing real on the ballot, and marks the top caption', () => {
    const round = captionRound();
    round.submitAnswer('alex', 'When the train leaves without you', 0);
    round.submitAnswer('sam', 'My face at the seventh temple', 0);
    round.startVote();
    expect(round.allEntries()).toHaveLength(2);
    round.vote('alex', entryIdOf(round, 'My face at the seventh temple'));
    round.resolve();
    expect(round.resultOf('sam').points).toBe(700);
    const top = round.revealRows((id) => id).at(-1)!;
    expect(top).toMatchObject({ top: true, author: 'sam', real: false });
  });

  it('knows who has the top caption, ties included, and nobody wins with no votes', () => {
    const round = captionRound();
    round.submitAnswer('alex', 'A cat judging the entire train platform', 0);
    round.submitAnswer('sam', 'Rush hour, as seen by the pigeons', 0);
    round.submitAnswer('priya', 'Somebody please bring more vending machines', 0);
    round.submitAnswer('jo', 'Local man discovers the concept of stairs', 0);
    round.startVote();
    const idOf = (viewer: string, text: string) => round.ballotFor(viewer).find((entry) => entry.text === text)!.id;
    round.vote('alex', idOf('alex', 'Rush hour, as seen by the pigeons'));
    round.vote('sam', idOf('sam', 'A cat judging the entire train platform'));
    round.vote('priya', idOf('priya', 'Rush hour, as seen by the pigeons'));
    round.vote('jo', idOf('jo', 'A cat judging the entire train platform'));
    expect(round.isTop('sam')).toBe(false); // Not until the votes are counted.
    round.resolve();
    expect(round.isTop('alex')).toBe(true);
    expect(round.isTop('sam')).toBe(true);
    expect(round.isTop('priya')).toBe(false);
    expect(round.isTop('nobody')).toBe(false);
  });

  it('never calls anyone top in Define it', () => {
    const round = defineRound();
    round.submitAnswer('alex', 'A quiet walk at dawn', 0);
    round.startVote();
    round.vote('sam', round.ballotFor('sam').find((entry) => entry.text === 'A quiet walk at dawn')!.id);
    round.resolve();
    expect(round.resultOf('alex').votes).toBe(1);
    expect(round.isTop('alex')).toBe(false);
  });

  it('skips voting with fewer than two captions', () => {
    const round = captionRound();
    round.submitAnswer('alex', 'Only one caption here', 0);
    round.startVote();
    expect(round.hasContest).toBe(false);
  });
});
