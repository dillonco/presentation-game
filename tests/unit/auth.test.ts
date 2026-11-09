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
    expect(auth.isSignedIn(`other=1; tp_admin=${value}; more=2`)).toBe(true);
    expect(auth.isSignedIn('other=1')).toBe(false);
    expect(auth.isSignedIn(undefined)).toBe(false);
  });

  it('says which space a session opens', () => {
    const auth = new AdminAuth({ password: 'open', sessionSecret: secret });
    expect(auth.spaceOf(auth.issue().value)).toBe('main');
    expect(auth.spaceOf(auth.issue('abcdefghijklmnop').value)).toBe('abcdefghijklmnop');
    expect(auth.spaceOf(auth.issue('not/a.space').value)).toBe(null);
  });

  it('signs hosted spaces without a password, but never the main space', () => {
    const auth = new AdminAuth({ sessionSecret: secret });
    expect(auth.enabled).toBe(false);
    expect(auth.canSign).toBe(true);
    expect(auth.spaceOf(auth.issue('abcdefghijklmnop').value)).toBe('abcdefghijklmnop');
    expect(auth.spaceOf(auth.issue('main').value)).toBe(null);
  });
});
