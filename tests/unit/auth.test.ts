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
    const [version, expires, space, signature] = value.split('.');
    expect(auth.isValid(`${version}.${Number(expires) + 9999}.${space}.${signature}`)).toBe(false);
    expect(auth.isValid(`${version}.${expires}.${space}.${signature}x`)).toBe(false);
    expect(auth.isValid(`${version}.${expires}.abcdefghijklmnop.${signature}`)).toBe(false);
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

  it('says which space a session opens', () => {
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret });
    auth.useSpaceGenerations((space) => (space === 'abcdefghijklmnop' ? 0 : null));
    expect(auth.spaceOf(auth.issue().value)).toBe('main');
    expect(auth.spaceOf(auth.issue('abcdefghijklmnop').value)).toBe('abcdefghijklmnop');
    expect(auth.spaceOf(auth.issue('not/a.space').value)).toBe(null);
  });

  it('signs hosted spaces without a password, but never the main space', () => {
    const auth = new AdminAuth({ sessionSecret: secret });
    auth.useSpaceGenerations(() => 0);
    expect(auth.enabled).toBe(false);
    expect(auth.canSign).toBe(true);
    expect(auth.spaceOf(auth.issue('abcdefghijklmnop').value)).toBe('abcdefghijklmnop');
    expect(auth.spaceOf(auth.issue('main').value)).toBe(null);
  });

  it("ends a space's sessions when its presenter link is reset, and refuses spaces that don't exist", () => {
    const auth = new AdminAuth({ sessionSecret: secret });
    let generation: number | null = 0;
    auth.useSpaceGenerations(() => generation);
    const before = auth.issue('abcdefghijklmnop').value;
    expect(auth.spaceOf(before)).toBe('abcdefghijklmnop');
    generation = 1;
    expect(auth.spaceOf(before)).toBe(null);
    expect(auth.spaceOf(auth.issue('abcdefghijklmnop').value)).toBe('abcdefghijklmnop');
    generation = null;
    expect(auth.spaceOf(auth.issue('abcdefghijklmnop').value)).toBe(null);
  });

  it("can't be talked into a newer generation by editing the cookie", () => {
    const auth = new AdminAuth({ sessionSecret: secret });
    let generation = 0;
    auth.useSpaceGenerations(() => generation);
    const [version, expires, space, , signature] = auth.issue('abcdefghijklmnop').value.split('.');
    generation = 1;
    expect(auth.spaceOf([version, expires, space, '1', signature].join('.'))).toBe(null);
  });

  it('signs every presenter out of the main space when the password changes', () => {
    const value = new AdminAuth({ password: 'old-password', sessionSecret: secret }).issue().value;
    expect(new AdminAuth({ password: 'old-password', sessionSecret: secret }).spaceOf(value)).toBe('main');
    expect(new AdminAuth({ password: 'new-password', sessionSecret: secret }).spaceOf(value)).toBe(null);
  });
});
