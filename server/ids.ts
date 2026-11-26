import { randomBytes } from 'node:crypto';

/** `bytes` random bytes in base64url, for every id the server hands out. */
export function randomId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}
