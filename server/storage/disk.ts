import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { assertSafeKey, assertSafePrefix, type Storage, type StoredObject } from './types.js';

const TYPE_SUFFIX = '.content-type';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class DiskStorage implements Storage {
  readonly backend = 'disk' as const;

  constructor(private readonly root: string) {}

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    assertSafeKey(key);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    // Write then rename, so a crash can't leave a half-written object behind.
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, body);
    await rename(temp, path);
    await writeFile(path + TYPE_SUFFIX, contentType);
  }

  async get(key: string): Promise<StoredObject | null> {
    assertSafeKey(key);
    const path = join(this.root, key);
    try {
      const [body, contentType] = await Promise.all([
        readFile(path),
        readFile(path + TYPE_SUFFIX, 'utf8').catch(() => 'application/octet-stream'),
      ]);
      return { body, contentType };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const path = join(this.root, key);
    await rm(path, { force: true });
    await rm(path + TYPE_SUFFIX, { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    assertSafePrefix(prefix);
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .filter((key) => !key.endsWith(TYPE_SUFFIX) && !key.endsWith('.tmp') && key.startsWith(prefix))
      .sort();
  }
}
