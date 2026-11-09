import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isVideoId, MEDIA_ID_PATTERN } from '../../shared/deck.js';
import { parseRange } from '../../server/deck-routes.js';
import { cleanVideo, newImageId, newVideoId } from '../../server/media.js';
import { box, MADE_AT, phoneVideo, PICTURE } from '../fixtures/mp4.js';

function madeAtBytes(): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(MADE_AT, 0);
  return bytes;
}

describe('cleaning an uploaded video', () => {
  it('removes the location, camera, software and dates', () => {
    const original = phoneVideo();
    for (const secret of ['+35.6586', 'SecretPhoneModel', 'SecretCameraMake', 'SecretSoftware', 'ISO6709']) {
      expect(original.includes(secret)).toBe(true);
    }
    expect(original.includes(madeAtBytes())).toBe(true);

    const clean = cleanVideo(original)!;
    for (const secret of ['+35.6586', 'SecretPhoneModel', 'SecretCameraMake', 'SecretSoftware', 'ISO6709']) {
      expect(clean.includes(secret)).toBe(false);
    }
    expect(clean.includes(madeAtBytes())).toBe(false);
  });

  it('keeps every frame exactly where it was', () => {
    const original = phoneVideo();
    const clean = cleanVideo(original)!;
    expect(clean.length).toBe(original.length);
    expect(clean.indexOf(PICTURE)).toBe(original.indexOf(PICTURE));
    expect(clean.subarray(0, 4)).toEqual(original.subarray(0, 4));
    expect(clean.toString('latin1', 4, 8)).toBe('ftyp');
    // The tracks that play are still there.
    expect(clean.includes('vide')).toBe(true);
    expect(clean.includes('soun')).toBe(true);
  });

  it('leaves the upload it was given alone', () => {
    const original = phoneVideo();
    const copy = Buffer.from(original);
    cleanVideo(original);
    expect(original).toEqual(copy);
  });

  it.each([
    ['a photo', readFileSync('tests/fixtures/plain.jpg')],
    ['nothing', Buffer.alloc(0)],
    ['a file cut short', phoneVideo().subarray(0, 60)],
    ['a file with no movie header', Buffer.concat([box('ftyp', Buffer.from('isom')), box('mdat', PICTURE)])],
    ['a file with no pictures', Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov')])],
    ['a file that does not start with its type', Buffer.concat([box('moov'), box('ftyp'), box('mdat')])],
    ['bytes hidden after the last box', Buffer.concat([phoneVideo(), Buffer.from('xyz')])],
  ])('refuses %s', (_name, input) => {
    expect(cleanVideo(input)).toBeNull();
  });

  it('refuses a box that claims to be bigger than the file', () => {
    const video = phoneVideo();
    video.writeUInt32BE(video.length * 2, 0);
    expect(cleanVideo(video)).toBeNull();
  });
});

describe('video ids', () => {
  it('tells videos from photos by their id', () => {
    const video = newVideoId();
    const photo = newImageId();
    expect(isVideoId(video)).toBe(true);
    expect(isVideoId(photo)).toBe(false);
    expect(MEDIA_ID_PATTERN.test(video)).toBe(true);
    expect(MEDIA_ID_PATTERN.test(photo)).toBe(true);
  });

  it('still treats a photo whose id happens to start with v as a photo', () => {
    const photo = `v${'a'.repeat(21)}`;
    expect(isVideoId(photo)).toBe(false);
    expect(MEDIA_ID_PATTERN.test(photo)).toBe(true);
  });
});

describe('sending part of a video', () => {
  it.each([
    ['bytes=0-', { start: 0, end: 999 }],
    ['bytes=0-1', { start: 0, end: 1 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
  ])('reads %s', (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });

  it.each(['bytes=1000-', 'bytes=5-2', 'bytes=-', 'bytes=-0', 'bytes=0-1,5-6', 'items=0-1', 'nonsense'])(
    'refuses %s',
    (header) => {
      expect(parseRange(header, 1000)).toBeNull();
    },
  );
});
