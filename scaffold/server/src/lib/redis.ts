import { Redis } from 'ioredis';
import { config } from '../config.js';

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

// A subscribed Redis connection can't run normal commands, so pub/sub gets its own.
let subscriber: Redis | undefined;

export function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    subscriber.on('error', (err) => console.warn('[redis-sub]', err.message));
  }
  return subscriber;
}

export async function closeRedis(): Promise<void> {
  await Promise.all(
    [redis, subscriber].filter(Boolean).map((c) => c!.quit().catch(() => c!.disconnect())),
  );
}
