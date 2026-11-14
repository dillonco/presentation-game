import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanJpeg, MAX_IMAGE_SIDE, MediaStore, newImageId, newVideoId } from '../../server/media.js';
import { DiskStorage } from '../../server/storage/disk.js';

const WITH_GPS = readFileSync('tests/fixtures/gps.jpg');
const PLAIN = readFileSync('tests/fixtures/plain.jpg');

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** A structurally valid JPEG with the given frame size. Enough for these checks. */
function tinyJpeg(width: number, height: number, extra: Buffer[] = []): Buffer {
  const frame = Buffer.alloc(6);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...extra,
    segment(0xc0, frame),
    segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('cleaning an uploaded photo', () => {
  it('removes location and camera details from a real photo', () => {
    expect(WITH_GPS.includes('SecretCameraMake')).toBe(true);
    expect(WITH_GPS.includes('Exif')).toBe(true);
    const clean = cleanJpeg(WITH_GPS)!;
    expect(clean.body.includes('SecretCameraMake')).toBe(false);
    expect(clean.body.includes('Exif')).toBe(false);
    expect(clean.width).toBe(2400);
    expect(clean.height).toBe(1600);
  });

  it('removes comments and every kind of application data', () => {
    const hidden = Buffer.from('HIDDEN-TEXT');
    const input = tinyJpeg(10, 10, [0xe0, 0xe1, 0xe2, 0xed, 0xef, 0xfe].map((marker) => segment(marker, hidden)));
    expect(cleanJpeg(input)!.body.includes(hidden)).toBe(false);
  });

  it('removes anything hidden after the end of the picture', () => {
    const input = Buffer.concat([PLAIN, Buffer.from('<script>alert(1)</script>')]);
    const clean = cleanJpeg(input)!;
    expect(clean.body.includes('<script>')).toBe(false);
    expect(clean.body.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('keeps the picture data intact, including stuffed bytes and restart markers', () => {
    const clean = cleanJpeg(tinyJpeg(10, 10))!;
    expect(clean.body.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]))).toBe(true);
  });

  it.each([
    ['an empty file', Buffer.alloc(0)],
    ['a web page', Buffer.from('<html><script>alert(1)</script></html>')],
    ['a PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    ['only the first two bytes', Buffer.from([0xff, 0xd8])],
    ['a photo cut off partway', WITH_GPS.subarray(0, WITH_GPS.length / 2)],
    ['a photo with no end', PLAIN.subarray(0, PLAIN.length - 2)],
    ['an end with no picture', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['a segment longer than the file', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00])],
    ['a segment with an impossible length', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0x00])],
  ])('refuses %s', (_name, input) => {
    expect(cleanJpeg(input)).toBeNull();
  });

  it('drops segments a decoder has no use for, so nothing chosen by the uploader rides along', () => {
    const hidden = Buffer.from('<html><script>alert(1)</script></html>');
    // JPG extensions, hierarchical progression and an unassigned marker.
    const input = tinyJpeg(10, 10, [0xc8, 0xde, 0xf0, 0xfd].map((marker) => segment(marker, hidden)));
    const clean = cleanJpeg(input)!;
    expect(clean).not.toBeNull();
    expect(clean.body.includes(hidden)).toBe(false);
  });

  it('refuses a second frame header, which could hide a far larger picture from the size check', () => {
    const huge = Buffer.alloc(6);
    huge[0] = 8;
    huge.writeUInt16BE(60_000, 1);
    huge.writeUInt16BE(60_000, 3);
    // The huge frame comes first, which is the one a decoder draws, then a small one to fool the check.
    expect(cleanJpeg(tinyJpeg(10, 10, [segment(0xc2, huge)]))).toBeNull();
  });

  it('refuses a scan before any frame header', () => {
    const scanFirst = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
      Buffer.from([0x12, 0xff, 0xd9]),
    ]);
    expect(cleanJpeg(scanFirst)).toBeNull();
  });

  it('refuses a photo too large for any phone to draw', () => {
    expect(cleanJpeg(tinyJpeg(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))).not.toBeNull();
    expect(cleanJpeg(tinyJpeg(MAX_IMAGE_SIDE + 1, 10))).toBeNull();
    expect(cleanJpeg(tinyJpeg(0, 10))).toBeNull();
  });
});

describe('the photo store', () => {
  let root: string;
  let storage: DiskStorage;
  let media: MediaStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'trip-party-media-test-'));
    storage = new DiskStorage(join(root, 'storage'));
    media = new MediaStore(storage, join(root, 'cache'));
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  it('gives every photo a long random name', () => {
    expect(newImageId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newImageId()).not.toBe(newImageId());
  });

  it('keeps photos in durable storage, not just on this machine', async () => {
    const id = newImageId();
    await media.save(id, 'full', PLAIN);
    expect((await storage.get(`images/${id}/full.jpg`))?.contentType).toBe('image/jpeg');
    const elsewhere = new MediaStore(storage, join(root, 'another-machine'));
    expect(await elsewhere.read(id, 'full')).toEqual(PLAIN);
  });

  it('answers from its local copy once it has one', async () => {
    const id = newImageId();
    await media.save(id, 'full', PLAIN);
    const fresh = new MediaStore(storage, join(root, 'fresh'));
    await fresh.warm([id]);
    await storage.delete(`images/${id}/full.jpg`);
    expect(await fresh.read(id, 'full')).toEqual(PLAIN);
  });

  it('forgets a deleted photo everywhere', async () => {
    const id = newImageId();
    await media.save(id, 'full', PLAIN);
    await media.save(id, 'small', PLAIN);
    await media.delete(id);
    expect(await media.read(id, 'full')).toBeNull();
    expect(await media.read(id, 'small')).toBeNull();
    expect(await storage.list('images/')).toEqual([]);
  });

  it('keeps its local copy under its size limit, dropping the least recently used first', async () => {
    const cacheDir = join(root, 'small-cache');
    const limited = new MediaStore(storage, cacheDir, PLAIN.length * 2);
    const [first, second, third] = [newImageId(), newImageId(), newImageId()];
    await limited.save(first, 'full', PLAIN);
    await limited.save(second, 'full', PLAIN);
    // Using the first makes the second the oldest.
    await limited.read(first, 'full');
    await limited.save(third, 'full', PLAIN);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(cacheDir)).sort()).toEqual([`${first}-full.jpg`, `${third}-full.jpg`].sort());
    // Storage still has it, so it simply comes back from there.
    expect(await limited.read(second, 'full')).toEqual(PLAIN);
  });

  it('counts what an earlier run left in its local copy', async () => {
    const cacheDir = join(root, 'shared-cache');
    const earlier = new MediaStore(storage, cacheDir);
    const left = [newImageId(), newImageId()];
    for (const id of left) await earlier.save(id, 'full', PLAIN);
    const later = new MediaStore(storage, cacheDir, PLAIN.length * 2);
    await later.save(newImageId(), 'full', PLAIN);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(cacheDir)).toHaveLength(2);
  });

  it('refuses a name that could reach outside its folder', async () => {
    await expect(media.read('../../etc/passwd', 'full')).rejects.toThrow('Invalid image id');
  });

  it('fetches a video once for a crowd asking at the same moment, streaming it to disk', async () => {
    const id = newVideoId();
    await storage.put(`images/${id}/video.mp4`, Buffer.alloc(1024, 7), 'video/mp4');
    let downloads = 0;
    const download = storage.download.bind(storage);
    storage.download = async (key, path) => {
      downloads += 1;
      return download(key, path);
    };
    const fresh = new MediaStore(storage, join(root, 'crowd'));
    const paths = await Promise.all(Array.from({ length: 20 }, () => fresh.videoFile(id)));
    expect(new Set(paths).size).toBe(1);
    expect(paths[0]).toMatch(/video\.mp4$/);
    expect(downloads).toBe(1);
    expect(await fresh.videoFile(newVideoId())).toBeNull();
  });

  it("adds up what each space keeps, as photos are claimed, grown and deleted", async () => {
    const space = 'abcdefghijklmnop';
    const id = newImageId();
    await media.save(id, 'full', PLAIN);
    await media.claim(space, id, PLAIN.length);
    expect(await media.bytesOwned(space)).toBe(PLAIN.length);
    await media.addBytes(space, id, 100);
    expect(await media.bytesOwned(space)).toBe(PLAIN.length + 100);
    // Worked out again from storage by another server, it's the same.
    expect(await new MediaStore(storage, join(root, 'other')).bytesOwned(space)).toBe(PLAIN.length + 100);
    await media.deleteOwned(space, id);
    expect(await media.bytesOwned(space)).toBe(0);
  });

  it('survives warming photos that are missing', async () => {
    await expect(media.warm([newImageId()])).resolves.toBeUndefined();
  });
});
