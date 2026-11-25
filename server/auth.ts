import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginSchema } from '../shared/messages.js';
import { TokenBucket } from './session/rate-limit.js';

const COOKIE_NAME = 'tp_admin';
/**
 * The name over HTTPS. Browsers only accept a __Host- cookie set by this exact host, with no
 * Domain, so a neighbouring app on a shared parent domain can't plant a session of its own here.
 */
const SECURE_COOKIE_NAME = `__Host-${COOKIE_NAME}`;

/** The request headers a session is read from. */
interface SessionHeaders {
  cookie?: string;
  'x-forwarded-proto'?: string | string[];
}

export function overHttps(headers: SessionHeaders): boolean {
  return headers['x-forwarded-proto'] === 'https';
}

/** Over HTTPS only the __Host- cookie counts, so a plain one planted from elsewhere is ignored. */
function sessionCookie(headers: SessionHeaders): string | null {
  return readCookie(headers.cookie, overHttps(headers) ? SECURE_COOKIE_NAME : COOKIE_NAME);
}
const SESSION_SECONDS = 12 * 60 * 60;
const MIN_SECRET_LENGTH = 16;

interface AuthOptions {
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

/** Signed, expiring presenter sessions. With no password configured, sign-in is simply off. */
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

  get enabled(): boolean {
    return this.password !== null;
  }

  private sign(expires: number): string {
    // Bound to the password too, so changing it signs every presenter out.
    const password = createHash('sha256').update(this.password ?? '').digest('base64url');
    return createHmac('sha256', this.secret!).update(`session.${expires}.${password}`).digest('base64url');
  }

  checkPassword(attempt: string): 'ok' | 'wrong' | 'limited' {
    if (!this.password) return 'wrong';
    if (sameText(attempt, this.password)) return 'ok';
    return this.failures.take(this.now()) ? 'wrong' : 'limited';
  }

  issue(): { value: string; maxAge: number } {
    const expires = Math.floor(this.now() / 1000) + SESSION_SECONDS;
    return { value: `${expires}.${this.sign(expires)}`, maxAge: SESSION_SECONDS };
  }

  /** False for a missing, altered or expired session, or one from before the password changed. */
  isValid(value: string | null): boolean {
    if (!this.password || !value) return false;
    const [expiresText, signature, extra] = value.split('.');
    if (!expiresText || !signature || extra !== undefined) return false;
    const expires = Number(expiresText);
    if (!Number.isInteger(expires) || expires * 1000 <= this.now()) return false;
    return sameText(signature, this.sign(expires));
  }

  isSignedIn(headers: SessionHeaders): boolean {
    return this.isValid(sessionCookie(headers));
  }
}

function setSessionCookie(reply: FastifyReply, request: FastifyRequest, value: string, maxAge: number): void {
  // Secure, and __Host-, only over HTTPS, so sign-in also works on a local development server.
  const secure = overHttps(request.headers);
  const name = secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
  reply.header(
    'set-cookie',
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
  );
}

export function registerAuthRoutes(fastify: FastifyInstance, auth: AdminAuth): void {
  fastify.post('/api/admin/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const result = auth.checkPassword(body.data.password);
    if (result === 'limited') return reply.code(429).send({ error: 'slow_down' });
    if (result === 'wrong') return reply.code(401).send({ error: 'wrong_password' });
    const session = auth.issue();
    setSessionCookie(reply, request, session.value, session.maxAge);
    return { ok: true };
  });

  fastify.post('/api/admin/logout', async (request, reply) => {
    setSessionCookie(reply, request, '', 0);
    return { ok: true };
  });
}

/** Route guard for anything presenter-only. */
export function requireAdmin(auth: AdminAuth) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!auth.isSignedIn(request.headers)) await reply.code(401).send({ error: 'unauthorized' });
  };
}
