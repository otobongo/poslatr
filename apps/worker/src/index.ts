import { loadEnv } from '@poslatr/core';
import { Redis } from 'ioredis';

const env = loadEnv();
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

let shuttingDown = false;

async function main(): Promise<void> {
  await redis.connect();
  console.log(`[worker] connected to redis, NODE_ENV=${env.NODE_ENV}`);
  console.log('[worker] BullMQ consumers land in ISS-007; idle until then.');
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] received ${signal}, shutting down gracefully`);
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err: unknown) => {
  console.error('[worker] fatal startup error', err);
  process.exit(1);
});
