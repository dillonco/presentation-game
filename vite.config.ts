import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Writes the service worker with an ID for this build, so a new release replaces the old files. */
function serviceWorker(): Plugin {
  return {
    name: 'trip-party-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const build = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./client/sw.js', import.meta.url), 'utf8').replace('__BUILD__', build);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root: 'client',
  plugins: [react(), serviceWorker()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    // Every file stays a real file, which the strict content security policy requires.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/media': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
