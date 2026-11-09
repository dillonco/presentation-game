import { TokenBucket } from './session/rate-limit.js';

/**
 * How many proxies in front of this server to trust, from TRUST_PROXY. Only a count: trusting
 * every hop would let a client name any address it likes in X-Forwarded-For.
 */
export function proxyHops(value: string | undefined): number {
  if (value === 'true') return 1;
  const hops = Number(value);
  return Number.isInteger(hops) && hops > 0 && hops < 10 ? hops : 0;
}

/**
 * The address a request really came from. With no trusted proxy that's the connection itself.
 * Each trusted proxy appends the address it saw, so the client is that many entries from the end.
 * Returns null when there's no trusted proxy, since then every visitor may look like one machine.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | string[] | undefined, hops: number): string | null {
  if (hops === 0) return null;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const chain = [
    ...header
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    remote ?? '',
  ];
  return chain[chain.length - 1 - hops] ?? chain[0] ?? null;
}

/**
 * The key an address is limited by. One IPv6 machine is usually handed a whole /64, so those
 * count as one visitor. IPv4, including IPv4 written in IPv6 form, is used as it is.
 */
export function visitorKey(address: string): string {
  const plain = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').split('%')[0]!;
  if (!plain.includes(':')) return plain;
  const [head = '', tail = ''] = plain.toLowerCase().split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = plain.includes('::') ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back] : front;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** A token bucket per visitor, forgetting the oldest once it knows too many. */
export class AddressBuckets {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly limit = 10_000,
  ) {}

  take(address: string, now: number): boolean {
    address = visitorKey(address);
    let bucket = this.buckets.get(address);
    if (bucket) {
      this.buckets.delete(address);
    } else {
      bucket = new TokenBucket(this.burst, this.perSecond, now);
      if (this.buckets.size >= this.limit) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(address, bucket);
    return bucket.take(now);
  }
}
