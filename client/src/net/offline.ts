/**
 * Starts the service worker that keeps the app's files on the device, so a refresh works on
 * very weak signal. Only in a real build, because it would get in the way of the dev server.
 */
export function keepAppOffline(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const path = window.location.pathname;
  // The deck builder always loads fresh.
  if (path === '/admin' || path.startsWith('/admin/')) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        // Files loaded before the worker took over aren't kept yet, so it's told about them.
        // Once more a little later, for screens that were still loading.
        const tell = () => {
          const paths = performance
            .getEntriesByType('resource')
            .map((entry) => new URL(entry.name))
            .filter((url) => url.origin === window.location.origin && url.pathname.startsWith('/assets/'))
            .map((url) => url.pathname);
          registration.active?.postMessage({ type: 'keep', paths });
        };
        tell();
        window.setTimeout(tell, 10_000);
      })
      .catch(() => {
        // Without it the app still works. A refresh just needs the network.
      });
  });
}
