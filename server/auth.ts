import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginSchema } from '../shared/messages.js';
import { TokenBucket } from './session/rate-limit.js';
import { MAIN_SPACE, SPACE_ID_PATTERN } from './spaces.js';

const COOKIE_NAME = 'tp_admin';
const SESSION_SECONDS = 12 * 60 * 60;
/** A hosted space has no password, so its browser stays the presenter for a long time. */
export const SPACE_SESSION_SECONDS = 180 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 16;

export interface AuthOptions {
  password?: string;
  sessionSecret?: string;
  now?: () => number;
}

function sameText(a: string, b: string): boolean {
  // Hashing first gives equal lengths, so the comparison reveals nothing about either value.
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Signed, expiring presenter sessions, each for one space. The password opens the main space.
 * With no password configured, password sign-in is simply off.
 */
export class AdminAuth {
  private readonly password: string | null;
  private readonly secret: string | null;
  private readonly now: () => number;
  // Shared by all callers, because a client-sent address can be faked. It can only delay a
  // sign-in: an existing session keeps working, and the presenter signs in before guests arrive.
  private readonly failures: TokenBucket;

  constructor(options: AuthOptions) {
    const secretIsUsable = (options.sessionSecret?.length ?? 0) >= MIN_SECRET_LENGTH;
    this.secret = secretIsUsable ? options.sessionSecret! : null;
    this.password = options.password && this.secret ? options.password : null;
    this.now = options.now ?? Date.now;
    this.failures = new TokenBucket(10, 10 / 60, this.now());
  }

  /** Password sign-in, to the main space. */
  get enabled(): boolean {
    return this.password !== null;
  }

  /** Sessions can be signed at all, which hosted spaces need even without a password. */
  get canSign(): boolean {
    return this.secret !== null;
  }

  private sign(space: string, expires: number): string {
    return createHmac('sha256', this.secret!).update(`v2.${space}.${expires}`).digest('base64url');
  }

  checkPassword(attempt: string): 'ok' | 'wrong' | 'limited' {
    if (!this.password) return 'wrong';
    if (sameText(attempt, this.password)) return 'ok';
    return this.failures.take(this.now()) ? 'wrong' : 'limited';
  }

  issue(space: string = MAIN_SPACE, seconds = SESSION_SECONDS): { value: string; maxAge: number } {
    const expires = Math.floor(this.now() / 1000) + seconds;
    return { value: `v2.${expires}.${space}.${this.sign(space, expires)}`, maxAge: seconds };
  }

  /** The space a session opens, or null for a missing, altered or expired one. */
  spaceOf(value: string | null): string | null {
    if (!this.secret || !value) return null;
    const [version, expiresText, space, signature, extra] = value.split('.');
    if (version !== 'v2' || !expiresText || !space || !signature || extra !== undefined) return null;
    if (space !== MAIN_SPACE && !SPACE_ID_PATTERN.test(space)) return null;
    // The main space is only reachable with the password, so its sessions end when the password is removed.
    if (space === MAIN_SPACE && !this.password) return null;
    const expires = Number(expiresText);
    if (!Number.isInteger(expires) || expires * 1000 <= this.now()) return null;
    return sameText(signature, this.sign(space, expires)) ? space : null;
  }

  isValid(value: string | null): boolean {
    return this.spaceOf(value) !== null;
  }

  presenterSpace(cookieHeader: string | undefined): string | null {
    return this.spaceOf(readCookie(cookieHeader, COOKIE_NAME));
  }

  isSignedIn(cookieHeader: string | undefined): boolean {
    return this.presenterSpace(cookieHeader) !== null;
  }
}

export function setSessionCookie(reply: FastifyReply, request: FastifyRequest, value: string, maxAge: number): void {
  // Secure only over HTTPS, so sign-in also works on a local development server.
  const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  reply.header('set-cookie', `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

export function registerAuthRoutes(fastify: FastifyInstance, auth: AdminAuth): void {
  fastify.post('/api/admin/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const result = auth.checkPassword(body.data.password);
    if (result === 'limited') return reply.code(429).send({ error: 'slow_down' });
    if (result === 'wrong') return reply.code(401).send({ error: 'wrong_password' });
    const session = auth.issue(MAIN_SPACE);
    setSessionCookie(reply, request, session.value, session.maxAge);
    return { ok: true };
  });

  fastify.post('/api/admin/logout', async (request, reply) => {
    setSessionCookie(reply, request, '', 0);
    return { ok: true };
  });
}

const spaces = new WeakMap<FastifyRequest, string>();

/** The space of the presenter making this request. Only set behind `requireAdmin`. */
export function spaceOf(request: FastifyRequest): string {
  const space = spaces.get(request);
  if (!space) throw new Error('spaceOf called outside requireAdmin');
  return space;
}

/** Route guard for anything presenter-only. */
export function requireAdmin(auth: AdminAuth) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const space = auth.presenterSpace(request.headers.cookie);
    if (!space) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    spaces.set(request, space);
  };
}

/** For the server's own numbers, which only whoever runs it should see. */
export function requireMainSpace(auth: AdminAuth) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (auth.presenterSpace(request.headers.cookie) !== MAIN_SPACE) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
