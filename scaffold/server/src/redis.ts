import { Redis } from 'ioredis';
import { config } from './config.js';

// Main connection for normal commands (counters, rate limit, sessions, publish).
let redis: Redis | undefined;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
    redis.on('error', (err) => console.warn('[redis]', err.message));
  }
  return redis;
}

// Called once at startup: waits until Redis answers.
export async function connectRedis(): Promise<void> {
  await getRedis().ping();
  console.log('[redis] connected');
}

export async function closeRedis(): Promise<void> {
  if (redis) await redis.quit().catch(() => redis?.disconnect());
}
