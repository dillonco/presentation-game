// Keeps the app's own files on the phone, so a refresh still works on very weak signal.
// The build fills in BUILD, so each release replaces the last one's files.
// Only the page shell and /assets/ are kept. Game data, photos, sockets, the deck builder
// and map tiles always go to the network.

const BUILD = '__BUILD__';
const CACHE = `trip-party-${BUILD}`;
const SHELL = '/__shell';
// How long a page load waits for the network before using the kept copy.
const SHELL_WAIT_MS = 3500;

const isAsset = (url) => url.origin === self.location.origin && url.pathname.startsWith('/assets/');
const isAdmin = (url) => url.pathname === '/admin' || url.pathname.startsWith('/admin/');

/** Keeps the shell and the files it names, so the first refresh after this is covered. */
async function keepShell(cache, response) {
  await cache.put(SHELL, response.clone());
  const html = await response.text();
  const named = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  await keepAll(cache, named);
}

async function keepAll(cache, paths) {
  await Promise.all(
    paths.map(async (path) => {
      const url = new URL(path, self.location.origin);
      if (!isAsset(url) || (await cache.match(url.pathname))) return;
      try {
        const response = await fetch(url.pathname);
        if (response.ok) await cache.put(url.pathname, response);
      } catch {
        // It'll be kept the next time the page loads it.
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch('/', { cache: 'no-cache' });
      if (response.ok) await keepShell(cache, response);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('trip-party-') && name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// The page lists the files it loaded before this worker was in charge of it.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'keep' || !Array.isArray(event.data.paths)) return;
  event.waitUntil(caches.open(CACHE).then((cache) => keepAll(cache, event.data.paths.slice(0, 200))));
});

async function fromAssets(request) {
  const cache = await caches.open(CACHE);
  const path = new URL(request.url).pathname;
  const kept = await cache.match(path);
  if (kept) return kept;
  const response = await fetch(request);
  // Only whole files are kept: the cache refuses a partial (206) reply.
  if (response.status === 200) await cache.put(path, response.clone());
  return response;
}

/** The network first, and the kept shell if the network fails or is too slow. */
async function fromShell(event) {
  const cache = await caches.open(CACHE);
  const fresh = fetch(event.request).then(async (response) => {
    if (response.ok) await cache.put(SHELL, response.clone());
    return response;
  });
  // A late reply still refreshes the kept copy.
  event.waitUntil(fresh.catch(() => undefined));
  const kept = await cache.match(SHELL);
  if (!kept) return fresh;
  const slow = new Promise((resolve) => setTimeout(() => resolve(null), SHELL_WAIT_MS));
  try {
    const first = await Promise.race([fresh, slow]);
    return first ?? kept;
  } catch {
    return kept;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (isAdmin(url)) return;
    event.respondWith(fromShell(event));
    return;
  }
  // Audio and video ask for one piece at a time, which can't be kept, so they go straight to the network.
  if (request.headers.has('range')) return;
  if (isAsset(url)) event.respondWith(fromAssets(request));
});
