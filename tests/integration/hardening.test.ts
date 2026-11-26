import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioConnect } from 'socket.io-client';
import { startHarness, type Harness } from './helpers.js';

const PHOTO = readFileSync('tests/fixtures/plain.jpg');

describe('hardening', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  it("refuses a large body on any route that isn't an upload, before reading it", async () => {
    harness = await startHarness();
    const cookie = await harness.signIn();
    const big = new Uint8Array(2 * 1024 * 1024);
    for (const [method, path, type] of [
      ['PUT', '/api/admin/decks/AAAAAAAAAAAAAAAA', 'video/mp4'],
      ['POST', '/api/admin/places', 'video/mp4'],
      ['POST', '/api/admin/decks', 'image/jpeg'],
    ] as const) {
      const response = await fetch(`${harness.url}${path}`, { method, headers: { cookie, 'content-type': type }, body: big });
      expect(response.status, `${method} ${path}`).toBe(413);
    }
    // The upload routes still take what they're for.
    const photo = await fetch(`${harness.url}/api/admin/images`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/jpeg' },
      body: PHOTO,
    });
    expect(photo.status).toBe(200);
  });

  describe('with FORCE_HTTPS', () => {
    it('sends plain HTTP to HTTPS, refuses changes over it, and leaves the health check alone', async () => {
      harness = await startHarness({ forceHttps: true });
      const page = await fetch(`${harness.url}/admin?x=1`, { redirect: 'manual' });
      expect(page.status).toBe(308);
      expect(page.headers.get('location')).toBe(`https://${new URL(harness.url).host}/admin?x=1`);

      const login = await fetch(`${harness.url}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'x' }),
      });
      expect(login.status).toBe(403);
      expect(await login.json()).toEqual({ error: 'https_only' });

      expect((await fetch(`${harness.url}/healthz`)).status).toBe(200);
      const secure = await fetch(`${harness.url}/api/admin/me`, { headers: { 'x-forwarded-proto': 'https' } });
      expect(secure.status).toBe(200);
    });

    it('refuses socket connections that came over plain HTTP', async () => {
      harness = await startHarness({ forceHttps: true });
      const connect = (headers: Record<string, string>) =>
        new Promise<void>((resolve, reject) => {
          const socket = ioConnect(harness!.url, {
            auth: { room: 'AAAAAAAAAAAAAAAAAAAAAA', role: 'guest' },
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            extraHeaders: headers,
          });
          harness!.sockets.push(socket);
          socket.once('connect', () => resolve());
          socket.once('connect_error', reject);
        });
      // Refused before the room is even looked for.
      await expect(connect({})).rejects.toThrow();
      await expect(connect({ 'x-forwarded-proto': 'https' })).rejects.toThrow('room_missing');
    });
  });

  it('caps the connections one address holds from their first request, not just once they join a room', async () => {
    harness = await startHarness({ trustProxy: 1, maxAddressConnections: 2 });
    // Engine handshakes that never go on to join a room still take a place each.
    const handshake = (ip: string) =>
      fetch(`${harness!.url}/socket.io/?EIO=4&transport=polling`, { headers: { 'x-forwarded-for': ip } }).then(
        (response) => response.status,
      );
    expect([await handshake('203.0.113.1'), await handshake('203.0.113.1')]).toEqual([200, 200]);
    expect(await handshake('203.0.113.1')).toBe(403);
    expect(await handshake('203.0.113.2')).toBe(200);
  });

  it('lets a TV go once its session runs out, even if it only watches', async () => {
    let now = Date.now();
    harness = await startHarness({ now: () => now, sessionCheckMs: 50 });
    const room = await harness.createRoom();
    const tv = await harness.host(room);
    expect(tv.connected).toBe(true);
    const gone = new Promise<void>((resolve) => tv.once('disconnect', () => resolve()));
    now += 13 * 60 * 60 * 1000;
    await gone;
  });
});
