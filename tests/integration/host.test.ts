import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken, send, startHarness, type Harness } from './helpers.js';

describe('hosting', () => {
  let harness: Harness;
  let room: string;

  beforeAll(async () => {
    harness = await startHarness();
    room = await harness.createRoom();
  });

  afterAll(() => harness.stop());

  it('reports healthy', async () => {
    const response = await fetch(`${harness.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each(['websocket', 'polling'] as const)('answers guests over %s', async (transport) => {
    const socket = await harness.guest(room, [transport]);
    expect(socket.io.engine.transport.name).toBe(transport);
    expect(await send(socket, 'guest:hello', { token: newToken() })).toMatchObject({ ok: true, status: 'new' });
  });

  it('drops oversized messages by closing the connection', async () => {
    const socket = await harness.guest(room);
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    socket.emit('guest:hello', 'x'.repeat(32 * 1024));
    expect(await closed).toBeTruthy();
  });

  it('sends strict security headers', async () => {
    const response = await fetch(`${harness.url}/healthz`);
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('pins HTTPS only when the request came over it', async () => {
    expect((await fetch(`${harness.url}/healthz`)).headers.get('strict-transport-security')).toBeNull();
    const secure = await fetch(`${harness.url}/healthz`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('keeps other sites from reaching into its windows or loading its files', async () => {
    const response = await fetch(`${harness.url}/healthz`);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('lets an uploaded file run nothing, even opened on its own', async () => {
    const response = await fetch(`${harness.url}/media/${'b'.repeat(22)}/full.jpg`);
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
  });

  it("lets only the TV and the deck builder load YouTube's player, for word clips", async () => {
    const policy = async (path: string) => (await fetch(`${harness.url}${path}`)).headers.get('content-security-policy')!;
    for (const path of [`/host/${room}`, '/admin']) {
      const allowed = await policy(path);
      expect(allowed).toContain('frame-src https://www.youtube-nocookie.com');
      expect(allowed).toMatch(/script-src [^;]*https:\/\/www\.youtube\.com/);
    }
    for (const path of [`/j/${room}`, '/', '/healthz']) {
      const phone = await policy(path);
      expect(phone).not.toContain('youtube');
      expect(phone).toContain("script-src 'self';");
    }
  });

  it('keeps the removed checks page gone', async () => {
    const response = await fetch(`${harness.url}/api/diag/storage`);
    expect(response.status).toBe(404);
  });
});

describe('serving the app', () => {
  let harness: Harness;
  let clientDir: string;

  beforeAll(async () => {
    clientDir = await mkdtemp(join(tmpdir(), 'trip-party-client-'));
    await mkdir(join(clientDir, 'assets'));
    await writeFile(join(clientDir, 'index.html'), '<!doctype html><title>Trip Party</title>');
    await writeFile(join(clientDir, 'assets', 'app-abc123.js'), 'export {};');
    harness = await startHarness({ clientDir });
  });

  afterAll(async () => {
    await harness.stop();
    await rm(clientDir, { recursive: true, force: true });
  });

  it('loads the same page for every screen', async () => {
    const response = await fetch(`${harness.url}/j/abc`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Trip Party</title>');
  });

  it('answers a file from an older release with 404, not the page', async () => {
    expect((await fetch(`${harness.url}/assets/app-abc123.js`)).status).toBe(200);
    const gone = await fetch(`${harness.url}/assets/app-old456.js`);
    expect(gone.status).toBe(404);
    expect(gone.headers.get('content-type')).not.toContain('text/html');
  });
});
