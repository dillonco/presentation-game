import { existsSync } from 'node:fs';
import { createApp } from './app.js';

// Settings from .env, for running on your own machine. Variables already set win.
if (existsSync('.env')) process.loadEnvFile('.env');

const { fastify, io, rooms } = await createApp({ logger: true });

const port = Number(process.env.PORT ?? 3000);
await fastify.listen({ port, host: '0.0.0.0' });

async function shutdown(signal: string): Promise<void> {
  fastify.log.info({ signal }, 'Shutting down');
  // Save first, because a redeploy replaces this pod while a game may be running.
  await rooms.flush().catch((error) => fastify.log.error(error, 'Final save failed'));
  await io.close();
  await fastify.close().catch(() => undefined);
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
