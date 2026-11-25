import { describe, expect, it } from 'vitest';
import { clientAddress, proxyHops, visitorKey } from '../../server/client-address.js';

describe("a visitor's address", () => {
  it('is unknown without a trusted proxy, whatever the request claims', () => {
    expect(clientAddress('10.0.0.1', '1.2.3.4', 0)).toBeNull();
  });

  it('is the entry the trusted proxy added, not one the client made up', () => {
    // The client sent "6.6.6.6" itself; the one proxy appended the address it saw.
    expect(clientAddress('10.0.0.1', '6.6.6.6, 1.2.3.4', 1)).toBe('1.2.3.4');
    expect(clientAddress('10.0.0.1', '6.6.6.6, 1.2.3.4, 10.0.0.2', 2)).toBe('1.2.3.4');
    expect(clientAddress('10.0.0.1', ['6.6.6.6', '1.2.3.4'], 1)).toBe('1.2.3.4');
  });

  it('reads TRUST_PROXY as a count of proxies, never "trust everything"', () => {
    expect(proxyHops(undefined)).toBe(0);
    expect(proxyHops('')).toBe(0);
    expect(proxyHops('true')).toBe(1);
    expect(proxyHops('2')).toBe(2);
    expect(proxyHops('-1')).toBe(0);
    expect(proxyHops('nonsense')).toBe(0);
  });

  it('counts a whole IPv6 /64 as one visitor', () => {
    expect(visitorKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(visitorKey('2001:0db8:0001:0002::9')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('::ffff:203.0.113.1')).toBe('203.0.113.1');
    expect(visitorKey('203.0.113.1')).toBe('203.0.113.1');
  });
});
