import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { randomId } from './session/room.js';
import type { Storage } from './storage/index.js';

/**
 * A space is one presenter's own corner of a hosted server: their decks, photos and games. On a
 * server you run yourself, everything belongs to the main space, opened with ADMIN_PASSWORD.
 */
export const MAIN_SPACE = 'main';
export const SPACE_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

/** Capitals only, without I and O, so a code read off a TV can't be mistyped as 1 or 0. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
export const JOIN_CODE_PATTERN = new RegExp(`^[${CODE_LETTERS}]{${CODE_LENGTH}}$`);

const spaceSchema = z.object({ id: z.string(), code: z.string(), createdAt: z.number() });
export type Space = z.infer<typeof spaceSchema>;
const codeSchema = z.object({ space: z.string() });

/** Tidies a code as typed: any case, with spaces or dashes. */
export function normaliseCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, '');
  return JOIN_CODE_PATTERN.test(code) ? code : null;
}

/** Where a space keeps everything of its own. */
export function spacePrefix(space: string): string {
  return `spaces/${space}/`;
}

export class SpaceStore {
  constructor(
    private readonly storage: Storage,
    private readonly secret: string,
    private readonly now: () => number,
  ) {}

  async create(): Promise<Space> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = Array.from({ length: CODE_LENGTH }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
      if (await this.storage.get(codeKey(code))) continue;
      const space: Space = { id: randomId(12), code, createdAt: this.now() };
      await this.storage.put(`${spacePrefix(space.id)}space.json`, JSON.stringify(space), 'application/json');
      await this.storage.put(codeKey(code), JSON.stringify({ space: space.id }), 'application/json');
      return space;
    }
    throw new Error('No free join code found');
  }

  async get(id: string): Promise<Space | null> {
    if (!SPACE_ID_PATTERN.test(id)) return null;
    return parse(spaceSchema, await this.storage.get(`${spacePrefix(id)}space.json`));
  }

  async spaceForCode(code: string): Promise<string | null> {
    return parse(codeSchema, await this.storage.get(codeKey(code)))?.space ?? null;
  }

  /**
   * The secret half of a presenter link. It's worked out from the server's secret rather than
   * stored, so the builder can show the link again at any time.
   */
  presenterKey(id: string): string {
    return createHmac('sha256', this.secret).update(`presenter:${id}`).digest('base64url');
  }

  checkPresenterKey(id: string, key: string): boolean {
    const expected = Buffer.from(this.presenterKey(id));
    const given = Buffer.from(key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

function codeKey(code: string): string {
  return `codes/${code}.json`;
}

function parse<T>(schema: z.ZodType<T>, stored: { body: Buffer } | null): T | null {
  if (!stored) return null;
  try {
    return schema.parse(JSON.parse(stored.body.toString('utf8')));
  } catch {
    return null;
  }
}
