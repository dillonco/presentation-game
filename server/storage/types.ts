export interface StoredObject {
  body: Buffer;
  contentType: string;
}

/**
 * Durable storage for decks, images and game snapshots.
 * The disk backend suits a single machine with a lasting disk. Hosts whose containers lose
 * their disk on each deploy should use S3.
 */
export interface Storage {
  readonly backend: 'disk' | 's3';
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  /** Returns null when the key doesn't exist. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Returns every key under a prefix. */
  list(prefix: string): Promise<string[]>;
}

const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Keys are built by our code, but this stops any path tricks reaching a backend. */
export function assertSafeKey(key: string): void {
  if (key.length > 512 || !SAFE_KEY.test(key)) {
    throw new Error('Invalid storage key');
  }
}

/** A prefix is a safe key with an optional trailing slash. */
export function assertSafePrefix(prefix: string): void {
  if (prefix === '') return;
  assertSafeKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
}
