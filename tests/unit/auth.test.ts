import { describe, expect, it } from 'vitest';
import { AdminAuth } from '../../server/auth.js';

const secret = 'a-long-enough-test-secret';

describe('AdminAuth', () => {
  it('stays off without both a password and a long secret', () => {
    expect(new AdminAuth({}).enabled).toBe(false);
    expect(new AdminAuth({ password: 'x' }).enabled).toBe(false);
    expect(new AdminAuth({ password: 'x', sessionSecret: 'short' }).enabled).toBe(false);
    expect(new AdminAuth({ password: 'x', sessionSecret: 'short' }).checkPassword('x')).toBe('wrong');
  });

  it('checks the password', () => {
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret });
    expect(auth.checkPassword('open')).toBe('ok');
    expect(auth.checkPassword('closed')).toBe('wrong');
  });

  it('limits repeated wrong passwords', () => {
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret, now: () => 0 });
    for (let i = 0; i < 10; i += 1) expect(auth.checkPassword('nope')).toBe('wrong');
    expect(auth.checkPassword('nope')).toBe('limited');
  });

  it('accepts its own sessions and rejects altered ones', () => {
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret });
    const { value } = auth.issue();
    expect(auth.isValid(value)).toBe(true);
    const [expires, signature] = value.split('.');
    expect(auth.isValid(`${Number(expires) + 9999}.${signature}`)).toBe(false);
    expect(auth.isValid(`${expires}.${signature}x`)).toBe(false);
    expect(auth.isValid(`${expires}.${signature}.extra`)).toBe(false);
    expect(auth.isValid('junk')).toBe(false);
    expect(auth.isValid(null)).toBe(false);
  });

  it('rejects a session signed with a different secret', () => {
    const value = new AdminAuth({ password: 'open', sessionSecret: secret }).issue().value;
    expect(new AdminAuth({ password: 'open', sessionSecret: `${secret}2` }).isValid(value)).toBe(false);
  });

  it('expires sessions', () => {
    let time = 1_000_000;
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret, now: () => time });
    const { value, maxAge } = auth.issue();
    time += (maxAge - 1) * 1000;
    expect(auth.isValid(value)).toBe(true);
    time += 2000;
    expect(auth.isValid(value)).toBe(false);
  });

  it('finds the session among other cookies', () => {
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret });
    const { value } = auth.issue();
    expect(auth.isSignedIn({ cookie: `other=1; tp_admin=${value}; more=2` })).toBe(true);
    expect(auth.isSignedIn({ cookie: 'other=1' })).toBe(false);
    expect(auth.isSignedIn({})).toBe(false);
  });

  it('over HTTPS, counts only the __Host- cookie, so one planted from a neighbouring app is ignored', () => {
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret });
    const { value } = auth.issue();
    const https = { 'x-forwarded-proto': 'https' };
    expect(auth.isSignedIn({ ...https, cookie: `__Host-tp_admin=${value}` })).toBe(true);
    expect(auth.isSignedIn({ ...https, cookie: `tp_admin=${value}` })).toBe(false);
    // Plain HTTP, for a development server, uses the plain name.
    expect(auth.isSignedIn({ cookie: `__Host-tp_admin=${value}` })).toBe(false);
  });

  it('signs every presenter out when the password changes', () => {
    const value = new AdminAuth({ password: 'old-password', sessionSecret: secret }).issue().value;
    expect(new AdminAuth({ password: 'old-password', sessionSecret: secret }).isValid(value)).toBe(true);
    expect(new AdminAuth({ password: 'new-password', sessionSecret: secret }).isValid(value)).toBe(false);
  });
});
