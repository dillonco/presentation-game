import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { createApp, type App, type AppOptions } from '../../server/app.js';
import { DiskStorage } from '../../server/storage/disk.js';
import type { GuestView, HostCommand, HostView } from '../../shared/protocol.js';

export const PASSWORD = 'test-password';
const SECRET = 'test-session-secret-long-enough';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface Harness {
  app: App;
  url: string;
  root: string;
  sockets: Socket[];
  signIn(): Promise<string>;
  createRoom(cookie?: string): Promise<string>;
  guest(room: string, transports?: ('websocket' | 'polling')[]): Promise<Socket>;
  host(room: string, cookie?: string): Promise<Socket>;
  stop(): Promise<void>;
  /** Stops the server but keeps its storage, to test a restart. */
  restart(): Promise<void>;
}

export async function startHarness(options: AppOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'trip-party-'));
  const build = () =>
    createApp({
      storage: new DiskStorage(root),
      clientDir: join(root, 'none'),
      mediaCacheDir: join(root, 'media-cache'),
      adminPassword: PASSWORD,
      sessionSecret: SECRET,
      snapshotDelayMs: 20,
      ...options,
    });

  async function listen(app: App, port = 0): Promise<string> {
    await app.fastify.listen({ port, host: '127.0.0.1' });
    return `http://127.0.0.1:${(app.fastify.server.address() as AddressInfo).port}`;
  }

  const harness: Harness = {
    app: await build(),
    url: '',
    root,
    sockets: [],

    async signIn() {
      const response = await fetch(`${harness.url}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = response.headers.get('set-cookie');
      if (!cookie) throw new Error('sign-in gave no cookie');
      return cookie.split(';')[0]!;
    },

    async createRoom(cookie) {
      const response = await fetch(`${harness.url}/api/admin/rooms`, {
        method: 'POST',
        headers: { cookie: cookie ?? (await harness.signIn()) },
      });
      return ((await response.json()) as { id: string }).id;
    },

    guest(room, transports = ['websocket']) {
      return open(harness, { room, role: 'guest' }, transports);
    },

    async host(room, cookie) {
      const extraHeaders = { cookie: cookie ?? (await harness.signIn()) };
      return open(harness, { room, role: 'host' }, ['websocket'], extraHeaders);
    },

    async stop() {
      await stopServer(harness.app, harness.sockets);
      await harness.app.rooms.flush();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },

    async restart() {
      const { port } = harness.app.fastify.server.address() as AddressInfo;
      await harness.app.rooms.flush();
      await stopServer(harness.app, harness.sockets);
      harness.sockets.length = 0;
      harness.app = await build();
      harness.url = await listen(harness.app, port);
    },
  };

  harness.url = await listen(harness.app);
  return harness;
}

async function stopServer(app: App, sockets: Socket[]): Promise<void> {
  sockets.forEach((socket) => socket.close());
  await app.io.close();
  await app.fastify.close().catch(() => undefined);
}

function open(
  harness: Harness,
  auth: { room: string; role: 'guest' | 'host' },
  transports: ('websocket' | 'polling')[],
  extraHeaders?: Record<string, string>,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(harness.url, {
      auth,
      transports,
      reconnection: false,
      forceNew: true,
      extraHeaders,
    });
    harness.sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

export function send<T = any>(socket: Socket, event: string, payload: unknown = {}): Promise<T> {
  return socket.timeout(2000).emitWithAck(event, payload);
}

export function hostHello(socket: Socket): Promise<{ ok: true; view: HostView }> {
  return send(socket, 'host:hello');
}

export function command(socket: Socket, value: HostCommand): Promise<{ ok: boolean; code?: string }> {
  return send(socket, 'host:command', value);
}

/** Resolves on the first view that passes the test. */
export function nextView<V extends HostView | GuestView>(
  socket: Socket,
  test: (view: V) => boolean = () => true,
): Promise<V> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('view', listener);
      reject(new Error('timed out waiting for a view'));
    }, 2000);
    function listener(view: V): void {
      if (!test(view)) return;
      clearTimeout(timer);
      socket.off('view', listener);
      resolve(view);
    }
    socket.on('view', listener);
  });
}

export function nextEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 2000);
    socket.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
