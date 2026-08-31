import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

/**
 * Wires up clear, consistently-labeled connection lifecycle logging for a raw ioredis client —
 * so "is Redis actually working" is answerable by reading logs instead of inferring it from
 * downstream symptoms (a queue silently not processing, admission checks silently failing open).
 */
export function attachRedisLogging(redis: Redis, logger: Logger, label: string): void {
  redis.on('connect', () => {
    const host = redis.options.host ?? 'unknown-host';
    const port = redis.options.port ?? 'unknown-port';
    logger.log(`[Redis:${label}] TCP connected (${host}:${String(port)})`);
  });
  redis.on('ready', () => {
    logger.log(`[Redis:${label}] ready — accepting commands`);
  });
  redis.on('error', (err: Error) => {
    logger.error(`[Redis:${label}] connection error: ${err.message}`);
  });
  redis.on('close', () => {
    logger.warn(`[Redis:${label}] connection closed`);
  });
  redis.on('reconnecting', (delayMs: number) => {
    logger.warn(`[Redis:${label}] reconnecting in ${String(delayMs)}ms`);
  });
  redis.on('end', () => {
    logger.warn(`[Redis:${label}] connection ended — no further reconnection attempts`);
  });
}

/** Human-readable summary of a redis-like client's current connection state (`.status`):
 *  'wait' | 'connecting' | 'connect' | 'ready' | 'close' | 'end' | 'reconnecting'. Accepts any
 *  ioredis-compatible client (including BullMQ's `Queue.client`, typed as `Redis | Cluster`)
 *  rather than the exact ioredis `Redis` type, since both expose the same `.status` field. */
export function redisStatusSummary(redis: { status: string } | null | undefined): {
  status: string;
  healthy: boolean;
} {
  if (!redis) return { status: 'not_initialized', healthy: false };
  return { status: redis.status, healthy: redis.status === 'ready' };
}
