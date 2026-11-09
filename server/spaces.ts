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

const spaceSchema = z.object({
  id: z.string(),
  code: z.string(),
  createdAt: z.number(),
  /** Goes up each time the presenter link is reset, which ends every earlier link and session. */
  generation: z.number().int().min(0).default(0),
  /** Roughly when its presenter last did anything, saved at most once a day. */
  lastUsedAt: z.number().optional(),
});
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
  /**
   * Every space, kept in memory too, so a session can be checked against its space's generation
   * on every request without reading storage. Filled by `load` when the server starts.
   */
  private readonly known = new Map<string, Space>();

  constructor(
    private readonly storage: Storage,
    private readonly secret: string,
    private readonly now: () => number,
  ) {}

  async load(): Promise<number> {
    for (const key of await this.storage.list('spaces/')) {
      const match = /^spaces\/([^/]+)\/space\.json$/.exec(key);
      if (!match || !SPACE_ID_PATTERN.test(match[1]!)) continue;
      const space = parse(spaceSchema, await this.storage.get(key));
      if (space && space.id === match[1]) this.known.set(space.id, space);
    }
    return this.known.size;
  }

  get count(): number {
    return this.known.size;
  }

  /** One change to a space at a time, so a slow save can never put back an older generation. */
  private readonly queues = new Map<string, Promise<unknown>>();

  private async write(space: Space): Promise<void> {
    this.known.set(space.id, space);
    await this.storage.put(`${spacePrefix(space.id)}space.json`, JSON.stringify(space), 'application/json');
  }

  /** Runs one piece of work on a space after any already on its way. */
  private inTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(work, work);
    const settled = result.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return result;
  }

  /** Applies a change to the space as it is now, after any change already on its way. */
  private update(id: string, change: (space: Space) => Space | null): Promise<Space | null> {
    return this.inTurn(id, async () => {
      const current = this.known.get(id);
      if (!current) return null;
      const next = change(current);
      if (!next) return current;
      await this.write(next);
      return next;
    });
  }

  async create(): Promise<Space> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = Array.from({ length: CODE_LENGTH }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
      if (await this.storage.get(codeKey(code))) continue;
      const space: Space = { id: randomId(12), code, createdAt: this.now(), generation: 0 };
      await this.write(space);
      await this.storage.put(codeKey(code), JSON.stringify({ space: space.id }), 'application/json');
      return space;
    }
    throw new Error('No free join code found');
  }

  async get(id: string): Promise<Space | null> {
    if (!SPACE_ID_PATTERN.test(id)) return null;
    return this.known.get(id) ?? null;
  }

  /** The space's current generation, or null for one that doesn't exist. Sessions must match it. */
  generation(id: string): number | null {
    return this.known.get(id)?.generation ?? null;
  }

  /** A new presenter link. Every earlier link, and every device signed in with one, stops working. */
  async resetPresenterKey(id: string): Promise<Space | null> {
    return this.update(id, (space) => ({ ...space, generation: space.generation + 1 }));
  }

  /** Notes that the space's presenter is using it. Saved at most once a day, so it costs little. */
  async touch(id: string): Promise<void> {
    const space = this.known.get(id);
    if (!space || this.now() - (space.lastUsedAt ?? space.createdAt) < TOUCH_EVERY_MS) return;
    await this.update(id, (current) => {
      const now = this.now();
      return now - (current.lastUsedAt ?? current.createdAt) < TOUCH_EVERY_MS ? null : { ...current, lastUsedAt: now };
    });
  }

  /** When the space was last used, for clearing out ones nobody comes back to. */
  lastUsed(id: string): number | null {
    const space = this.known.get(id);
    return space ? (space.lastUsedAt ?? space.createdAt) : null;
  }

  ids(): string[] {
    return [...this.known.keys()];
  }

  /** Forgets the space and its join code. Its decks and photos must already be gone. */
  async delete(id: string): Promise<void> {
    await this.inTurn(id, async () => {
      const space = this.known.get(id);
      if (!space) return;
      this.known.delete(id);
      await this.storage.delete(codeKey(space.code));
      await this.storage.delete(`${spacePrefix(id)}space.json`);
    });
  }

  async spaceForCode(code: string): Promise<string | null> {
    return parse(codeSchema, await this.storage.get(codeKey(code)))?.space ?? null;
  }

  /**
   * The secret half of a presenter link. It's worked out from the server's secret and the space's
   * generation rather than stored, so the builder can show the link again at any time.
   */
  presenterKey(id: string): string {
    const generation = this.generation(id) ?? 0;
    return createHmac('sha256', this.secret).update(`presenter:${id}:${generation}`).digest('base64url');
  }

  checkPresenterKey(id: string, key: string): boolean {
    if (this.generation(id) === null) return false;
    const expected = Buffer.from(this.presenterKey(id));
    const given = Buffer.from(key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}

const TOUCH_EVERY_MS = 24 * 60 * 60 * 1000;

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
