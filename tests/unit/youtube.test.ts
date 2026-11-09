import { describe, expect, it } from 'vitest';
import { deckToSetup } from '../../server/decks.js';
import { Room } from '../../server/session/room.js';
import { deckContentSchema, deckProblems, emptyDeck, type DeckClip, type DeckContent } from '../../shared/deck.js';
import { formatClipTime, parseClipTime, parseYouTubeLink } from '../../shared/youtube.js';

const VIDEO = '0ZFMAM9_U9c';

function wordDeck(clip?: DeckClip): DeckContent {
  const item = { word: 'komorebi', definition: 'Sunlight filtering through the leaves of trees' };
  return {
    ...emptyDeck(),
    title: 'Japan 2026',
    games: [{ type: 'define', settings: {}, items: [clip ? { ...item, clip } : item] }],
  };
}

describe('reading a YouTube link', () => {
  it.each([
    [`https://youtu.be/${VIDEO}`, null],
    [`https://youtu.be/${VIDEO}?si=abc&t=73`, 73],
    [`https://www.youtube.com/watch?v=${VIDEO}`, null],
    [`https://www.youtube.com/watch?v=${VIDEO}&t=1m5s`, 65],
    [`https://m.youtube.com/watch?v=${VIDEO}&t=12s`, 12],
    [`https://www.youtube.com/shorts/${VIDEO}`, null],
    [`https://www.youtube.com/embed/${VIDEO}?start=8`, 8],
    [`https://www.youtube-nocookie.com/embed/${VIDEO}`, null],
    [`  https://youtu.be/${VIDEO}  `, null],
  ])('reads %s', (link, start) => {
    expect(parseYouTubeLink(link)).toEqual({ video: VIDEO, start });
  });

  it.each([
    ['', 'nothing'],
    ['komorebi', 'a word'],
    [`https://vimeo.com/${VIDEO}`, 'another site'],
    [`https://youtube.com.evil.example/watch?v=${VIDEO}`, 'a look-alike host'],
    ['https://www.youtube.com/watch?v=short', 'a broken id'],
    [`javascript:alert(1)//youtu.be/${VIDEO}`, 'a script'],
    ['https://www.youtube.com/@julienmiquel', 'a channel'],
  ])('refuses %s (%s)', (link) => {
    expect(parseYouTubeLink(link)).toBeNull();
  });
});

describe('clip times', () => {
  it.each([
    ['12', 12],
    ['12.5', 12.5],
    ['1:05', 65],
    ['1:05.25', 65.3],
    ['1:01:05', 3665],
    [' 0:08 ', 8],
  ])('reads %s', (text, seconds) => {
    expect(parseClipTime(text)).toBe(seconds);
  });

  it.each(['', 'soon', '1:75', '1:60:00', '-3', '1::5', '1.5:00'])('refuses %j', (text) => {
    expect(parseClipTime(text)).toBeNull();
  });

  it('writes a time back the way YouTube shows it', () => {
    expect(formatClipTime(8)).toBe('0:08');
    expect(formatClipTime(65.3)).toBe('1:05.3');
    expect(formatClipTime(3665)).toBe('1:01:05');
    expect(parseClipTime(formatClipTime(65.3))).toBe(65.3);
  });
});

describe('a word clip in a deck', () => {
  it('still loads decks made before clips existed', () => {
    expect(deckContentSchema.safeParse(wordDeck()).success).toBe(true);
    expect(deckProblems(wordDeck())).toEqual([]);
  });

  it('saves a half-pasted link, but holds the deck back until the clip is fixed', () => {
    const draft = wordDeck({ url: 'https://yout', start: null, end: null });
    expect(deckContentSchema.safeParse(draft).success).toBe(true);
    expect(deckProblems(draft)).toEqual(['Define it, word 1: paste a YouTube link for the clip.']);
  });

  it('treats a clip with nothing filled in as no clip', () => {
    expect(deckProblems(wordDeck({ url: '  ', start: null, end: null }))).toEqual([]);
  });

  it.each([
    [{ start: 12, end: null }, 'set when the clip starts and ends'],
    [{ start: 12, end: 12 }, 'make the clip end after it starts'],
    [{ start: 12, end: 40 }, 'keep the clip to 20 seconds or less'],
  ])('asks for a usable stretch of video: %j', (times, problem) => {
    const deck = wordDeck({ url: `https://youtu.be/${VIDEO}`, ...times });
    expect(deckProblems(deck)).toEqual([`Define it, word 1: ${problem}.`]);
  });

  it('refuses a time below zero', () => {
    expect(deckContentSchema.safeParse(wordDeck({ url: `https://youtu.be/${VIDEO}`, start: -1, end: 2 })).success).toBe(false);
  });

  it('hands the game only the video and its times', () => {
    const setup = deckToSetup(wordDeck({ url: `https://youtu.be/${VIDEO}?t=12`, start: 12.4, end: 14.9 }));
    expect(setup.games[0]).toMatchObject({
      items: [{ word: 'komorebi', clip: { video: VIDEO, start: 12.4, end: 14.9 } }],
    });
    // A word with no clip carries no clip field at all.
    expect(deckToSetup(wordDeck()).games[0]).toMatchObject({ items: [{ word: 'komorebi' }] });
    expect(JSON.stringify(deckToSetup(wordDeck()))).not.toContain('clip');
  });

  it('puts the clip on the writing screen and keeps it after a restart', () => {
    const clip = { video: VIDEO, start: 12.4, end: 14.9 };
    const room = new Room(
      'room',
      { title: 'Test', games: [{ type: 'define', items: [{ word: 'komorebi', definition: 'Sunlight', clip }] }] },
      0,
    );
    const joined = room.join('hash-alex', 'Alex', 1);
    if (joined.kind !== 'joined') throw new Error('expected to join');
    room.connect(joined.playerId, 1);
    room.next(room.screenId, 10);
    room.next(room.screenId, 10);
    const screen = room.hostView().screen;
    if (screen.kind !== 'write') throw new Error(`expected writing, got ${screen.kind}`);
    expect(screen.round).toMatchObject({ prompt: 'komorebi', clip });

    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(room.toSnapshot())), 20)!;
    expect(restored.hostView().screen).toMatchObject({ kind: 'write', round: { clip } });
  });
});
