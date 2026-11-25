import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { Server as SocketServer } from 'socket.io';
import { AdminAuth, overHttps, registerAuthRoutes, requireAdmin } from './auth.js';
import { deckRoutes, registerMediaRoute } from './deck-routes.js';
import { DeckStore } from './decks.js';
import { MediaStore } from './media.js';
import { RoomManager } from './session/manager.js';
import { registerSessions, type Sessions } from './session/sockets.js';
import { clientAddress, proxyHops } from './client-address.js';
import { createStorage, type Storage } from './storage/index.js';

const MAP_TILES = 'https://tiles.openfreemap.org';

export interface AppOptions {
  storage?: Storage;
  clientDir?: string;
  logger?: boolean;
  adminPassword?: string;
  sessionSecret?: string;
  now?: () => number;
  snapshotDelayMs?: number;
  tickMs?: number;
  mediaCacheDir?: string;
  /** Tests lower these, rather than opening 150 connections or 500 games. */
  maxRoomConnections?: number;
  maxRooms?: number;
  maxVideoUploads?: number;
  /** How many proxies in front of the server to trust for the visitor's address. TRUST_PROXY. */
  trustProxy?: number;
  maxAddressConnections?: number;
  /**
   * Sends every visitor to HTTPS. FORCE_HTTPS=true. Only for a server behind a proxy that says
   * which a request arrived over (X-Forwarded-Proto), as every HTTPS host does.
   */
  forceHttps?: boolean;
  /** How often a connected TV's session is checked again. Tests shorten it. */
  sessionCheckMs?: number;
  /**
   * Offers the sample deck, for trying a whole game while developing. Off in production
   * (NODE_ENV=production, as the Docker image sets), where decks are only ever the presenter's own.
   */
  sampleDeck?: boolean;
}

export interface App {
  fastify: FastifyInstance;
  io: SocketServer;
  storage: Storage;
  rooms: RoomManager;
  sessions: Sessions;
  decks: DeckStore;
  media: MediaStore;
}

function defaultClientDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'client');
}

/** YouTube's player script, which loads the rest of itself from the same host. */
const YOUTUBE_SCRIPTS = 'https://www.youtube.com';
/** The privacy-enhanced player, which sets no cookies until a video plays. */
const YOUTUBE_FRAMES = 'https://www.youtube-nocookie.com';

/** A Host header that's only a name or address and a port, so it's safe to put in a header. */
const SAFE_HOST = /^[A-Za-z0-9.:[\]-]+$/;

/** Only scripts, styles and fonts from this server run. Guest text can never become code. */
function contentSecurityPolicy(host: string | undefined, path: string): string {
  const socketOrigin = host && SAFE_HOST.test(host) ? ` wss://${host} ws://${host}` : '';
  const builder = path === '/admin' || path.startsWith('/admin/');
  // Define it's word clips play in YouTube's player, on the TV and in the builder's preview. Phones never get it.
  const youtube = builder || path.startsWith('/host/');
  // Only the deck builder needs wasm, for reading iPhone photos. Guests and the TV never get it.
  const scripts = ["'self'", builder ? "'wasm-unsafe-eval'" : '', youtube ? YOUTUBE_SCRIPTS : ''].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    ...(youtube ? [`frame-src ${YOUTUBE_FRAMES}`] : []),
    "style-src 'self'",
    "font-src 'self'",
    // Giphy for the funny GIFs between games.
    `img-src 'self' data: blob: ${MAP_TILES} https://media.giphy.com https://*.giphy.com`,
    // Videos come from this server. The builder also opens a chosen file itself, to take its poster.
    "media-src 'self' blob:",
    `connect-src 'self'${socketOrigin} ${MAP_TILES}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const MEDIA_POLICY = "default-src 'none'; sandbox; frame-ancestors 'none'";

/** Paths that carry a room id, which is all anyone needs to get into a game. */
const SECRET_PATHS = /^(\/(?:j|host|api\/admin\/rooms)\/)[^/?#]+/;

/** A request address safe to log: room ids are blanked, and the query is dropped. */
export function redactUrl(url: string): string {
  const path = url.split('?')[0]!;
  return path.replace(SECRET_PATHS, '$1…');
}

export async function createApp(options: AppOptions = {}): Promise<App> {
  const hops = options.trustProxy ?? proxyHops(process.env.TRUST_PROXY);
  const fastify = Fastify({
    logger: options.logger
      ? {
          serializers: {
            // Room ids open a game, so they never go into the logs.
            req: (request: { method: string; url: string; ip?: string }) => ({
              method: request.method,
              url: redactUrl(request.url),
              remoteAddress: request.ip,
            }),
          },
        }
      : false,
    bodyLimit: 1024 * 1024,
    // A slow upload can't hold one of the few upload slots for ever. 10 minutes is enough for
    // a 100 MB video over a weak connection.
    requestTimeout: 10 * 60 * 1000,
    // Behind Kiteware or another proxy, so request.ip is the visitor rather than the proxy.
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  });
  const storage = options.storage ?? createStorage();

  const io = new SocketServer(fastify.server, {
    // Small messages only. Photos travel over HTTP, never the socket.
    maxHttpBufferSize: 16 * 1024,
    // Heartbeats also stop idle proxies from closing quiet connections.
    pingInterval: 20_000,
    pingTimeout: 25_000,
    // Fall back to long polling on networks that block WebSockets.
    transports: ['websocket', 'polling'],
    connectionStateRecovery: undefined,
    // A connection that never says which room it wants gives up its place quickly.
    connectTimeout: 10_000,
  });

  const auth = new AdminAuth({
    password: options.adminPassword ?? process.env.ADMIN_PASSWORD,
    sessionSecret: options.sessionSecret ?? process.env.SESSION_SECRET,
    now: options.now,
  });
  if (!auth.enabled) {
    fastify.log.warn(
      'ADMIN_PASSWORD and SESSION_SECRET (16+ characters) are not both set, so nobody can sign in to build decks. Run npm run setup.',
    );
  }

  const rooms = new RoomManager({
    storage,
    now: options.now,
    snapshotDelayMs: options.snapshotDelayMs,
    maxRooms: options.maxRooms,
    onSnapshotError: (error) => fastify.log.error(error, 'Saving game state failed'),
  });
  const restored = await rooms.restore();
  if (restored > 0) fastify.log.info({ restored }, 'Restored rooms from storage');
  const forceHttps = options.forceHttps ?? ['true', '1'].includes(process.env.FORCE_HTTPS ?? '');
  const sessions = registerSessions(io, rooms, auth, {
    tickMs: options.tickMs,
    maxRoomConnections: options.maxRoomConnections,
    maxAddressConnections: options.maxAddressConnections,
    addressOf: (remote, headers) => clientAddress(remote, headers['x-forwarded-for'], hops),
    forceHttps,
    sessionCheckMs: options.sessionCheckMs,
  });

  if (forceHttps) {
    // Over plain HTTP a sign-in cookie can't be Secure, and anyone on the network could read it.
    fastify.addHook('onRequest', async (request, reply) => {
      // The host's health check comes straight to the server, over plain HTTP.
      if (request.url === '/healthz' || overHttps(request.headers)) return;
      const host = request.headers.host;
      if ((request.method === 'GET' || request.method === 'HEAD') && host && SAFE_HOST.test(host)) {
        await reply.redirect(`https://${host}${request.url}`, 308);
        return;
      }
      await reply.code(403).send({ error: 'https_only' });
    });
  }

  // Nothing that changes anything may come from another site. Without this, a page elsewhere
  // could post a form here and act with a signed-in presenter's cookie.
  fastify.addHook('onRequest', async (request, reply) => {
    // Every path, not just /api/, so no odd spelling of a path can slip past.
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    const { origin, host } = request.headers;
    const fetchSite = request.headers['sec-fetch-site'];
    // "same-site" counts too: on a shared hosting domain, a neighbouring app is the same site and
    // would otherwise get the presenter's SameSite cookie. Socket.IO's own requests never reach here.
    const otherSite = fetchSite === 'cross-site' || fetchSite === 'same-site';
    const crossOrigin = otherSite || (origin ? !URL.canParse(origin) || new URL(origin).host !== host : false);
    if (crossOrigin) await reply.code(403).send({ error: 'cross_site' });
  });

  fastify.addHook('onSend', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    // An upload is only ever a picture or a video, so its own address may run and embed nothing at all.
    const policy = path.startsWith('/media/') ? MEDIA_POLICY : contentSecurityPolicy(request.headers.host, path);
    reply.header('content-security-policy', policy);
    // Only over HTTPS, so a development server on plain HTTP is never pinned to it.
    if (overHttps(request.headers) || request.protocol === 'https') {
      reply.header('strict-transport-security', 'max-age=31536000');
    }
    // No other site may open this one in a window it can reach into, or load its photos and pages.
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    // Deck data holds real answers, so it should never sit in a browser or proxy cache.
    if (path.startsWith('/api/')) reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    // Room links are private, so they must not leak to other sites.
    reply.header('referrer-policy', 'no-referrer');
  });

  fastify.get('/healthz', async () => ({ ok: true }));

  registerAuthRoutes(fastify, auth);
  fastify.get('/api/admin/me', async (request) => ({ signedIn: auth.isSignedIn(request.headers) }));

  // How hard the server is working, for the load test and for checking on game night.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  let lastCpu = process.cpuUsage();
  let lastCpuAt = performance.now();
  fastify.get('/api/admin/stats', { preHandler: requireAdmin(auth) }, async (request) => {
    const cpu = process.cpuUsage(lastCpu);
    const at = performance.now();
    const cpuPercent = ((cpu.user + cpu.system) / 1000 / Math.max(1, at - lastCpuAt)) * 100;
    lastCpu = process.cpuUsage();
    lastCpuAt = at;
    const memory = process.memoryUsage();
    const ms = (nanoseconds: number) => Math.round(nanoseconds / 1e5) / 10;
    const stats = {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      rssMb: Math.round(memory.rss / 1048576),
      heapMb: Math.round(memory.heapUsed / 1048576),
      loopDelayMs: { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) },
      connections: io.engine.clientsCount,
      rooms: rooms.list().length,
      // The address this server thinks you're at, to check that TRUST_PROXY sees real visitors.
      yourAddress: request.ip,
    };
    loopDelay.reset();
    return stats;
  });
  fastify.addHook('onClose', async () => loopDelay.disable());

  const decks = new DeckStore(storage, rooms.now);
  const cacheMb = Number(process.env.MEDIA_CACHE_MB);
  const media = new MediaStore(
    storage,
    options.mediaCacheDir,
    Number.isFinite(cacheMb) && cacheMb > 0 ? cacheMb * 1024 * 1024 : undefined,
  );
  registerMediaRoute(fastify, media);
  await fastify.register(
    deckRoutes({
      auth,
      decks,
      media,
      rooms,
      sessions,
      maxVideoUploads: options.maxVideoUploads,
      sampleDeck: options.sampleDeck ?? process.env.NODE_ENV !== 'production',
      onError: (error, message) => fastify.log.error(error, message),
    }),
  );

  const clientDir = options.clientDir ?? defaultClientDir();
  if (existsSync(clientDir)) {
    await fastify.register(fastifyStatic, {
      root: clientDir,
      wildcard: false,
      // The build compresses every file ahead of time.
      preCompressed: true,
      cacheControl: false,
      setHeaders: (reply, path) => {
        // Vite puts a content hash in every asset name, so those never change.
        const immutable = path.replaceAll('\\', '/').includes('/assets/');
        reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    // Client-side routes such as /j/<room> all load the same page. A missing file under
    // /assets/ is a real 404: after a release, a page still open from the last one asks for
    // files that are gone, and the page in their place would be kept as if it were code.
    fastify.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/') || request.url.startsWith('/assets/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  fastify.addHook('onClose', async () => {
    sessions.close();
    rooms.close();
  });

  return { fastify, io, storage, rooms, sessions, decks, media };
}
