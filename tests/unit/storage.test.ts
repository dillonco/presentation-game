import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskStorage } from '../../server/storage/disk.js';
import { createStorage } from '../../server/storage/index.js';
import { assertSafeKey } from '../../server/storage/types.js';

describe('DiskStorage', () => {
  let root: string;
  let storage: DiskStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'trip-party-'));
    storage = new DiskStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores and returns an object with its content type', async () => {
    await storage.put('decks/one/deck.json', '{"a":1}', 'application/json');
    const stored = await storage.get('decks/one/deck.json');
    expect(stored?.body.toString()).toBe('{"a":1}');
    expect(stored?.contentType).toBe('application/json');
  });

  it('returns null for a missing key', async () => {
    expect(await storage.get('decks/nope.json')).toBeNull();
  });

  it('replaces an existing object', async () => {
    await storage.put('a/b', 'first', 'text/plain');
    await storage.put('a/b', 'second', 'text/plain');
    expect((await storage.get('a/b'))?.body.toString()).toBe('second');
  });

  it('deletes objects, and deleting a missing one is fine', async () => {
    await storage.put('a/b', 'x', 'text/plain');
    await storage.delete('a/b');
    await storage.delete('a/b');
    expect(await storage.get('a/b')).toBeNull();
  });

  it('lists only keys under a prefix, without internal files', async () => {
    await storage.put('decks/one/deck.json', '1', 'application/json');
    await storage.put('decks/two/deck.json', '2', 'application/json');
    await storage.put('sessions/room.json', '3', 'application/json');
    expect(await storage.list('decks/')).toEqual(['decks/one/deck.json', 'decks/two/deck.json']);
  });

  it('returns an empty list when nothing has been stored', async () => {
    const empty = new DiskStorage(join(root, 'does-not-exist'));
    expect(await empty.list('decks/')).toEqual([]);
  });
});

describe('storage keys', () => {
  it.each(['decks/one/deck.json', 'media/abc_123.webp', 'a'])('accepts %s', (key) => {
    expect(() => assertSafeKey(key)).not.toThrow();
  });

  it.each(['../secret', 'a/../../b', '/etc/passwd', 'a//b', '.hidden', 'a\\b', 'a b', '', 'a/'])(
    'rejects %j',
    (key) => {
      expect(() => assertSafeKey(key)).toThrow();
    },
  );

  it('refuses to read outside the storage folder', async () => {
    const storage = new DiskStorage(tmpdir());
    await expect(storage.get('../../etc/passwd')).rejects.toThrow('Invalid storage key');
  });
});

describe('createStorage', () => {
  it('uses disk when S3 variables are missing', () => {
    expect(createStorage({ DATA_DIR: tmpdir() }).backend).toBe('disk');
  });

  it('uses disk when S3 variables are only partly set', () => {
    expect(createStorage({ DATA_DIR: tmpdir(), S3_BUCKET: 'x' }).backend).toBe('disk');
  });

  it('uses S3 at an endpoint, such as MinIO', () => {
    const storage = createStorage({
      S3_ENDPOINT_URL: 'http://minio.local:9000',
      S3_BUCKET: 'bucket',
      S3_ACCESS_KEY: 'test-access',
      S3_SECRET_KEY: 'test-secret',
    });
    expect(storage.backend).toBe('s3');
  });

  it('uses Amazon S3 itself when no endpoint is set', () => {
    const storage = createStorage({ S3_BUCKET: 'bucket', S3_ACCESS_KEY: 'test-access', S3_SECRET_KEY: 'test-secret' });
    expect(storage.backend).toBe('s3');
  });
});
