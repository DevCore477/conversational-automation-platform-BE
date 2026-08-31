import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';

import callQueueConfig from '../../configs/call-queue.config';
import redisConfig from '../../configs/redis.config';
import { attachRedisLogging, redisStatusSummary } from '../../common/utils/redis-logging.util';
import { withTimeout } from '../../common/utils/with-timeout.util';
import { OutboundCallQueueService } from '../queue/outbound-call-queue.service';

const ACTIVE_INBOUND_ZSET_KEY = 'calls:active:inbound';

export interface InboundAdmissionResult {
  admitted: boolean;
  /** Present when rejected — which limit was hit, for logging/metrics. */
  reason?: 'inbound_capacity' | 'total_capacity';
  activeInbound: number;
  activeOutbound: number;
}

/**
 * Caps how many inbound calls can be simultaneously admitted (answered), backed by a Redis
 * sorted set so the count is correct across every app instance in a horizontally-scaled
 * deployment — not just the process that happens to receive a given webhook. Self-healing: each
 * admitted call is stored with an expiry (CALL_TIMEOUT_MS out), so a crashed instance that never
 * calls `release()` cannot permanently leak capacity — the stale entry ages out and stops
 * counting against the limit on its own, on the next admission check.
 */
@Injectable()
export class InboundCallAdmissionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundCallAdmissionService.name);
  private redis: Redis | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly outboundCallQueue: OutboundCallQueueService,
  ) {}

  onModuleInit(): void {
    // Connect eagerly (not lazily on first inbound call) so connection status is visible in
    // startup logs right away instead of only surfacing on the first live call.
    this.getRedis();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      // Graceful QUIT is itself a Redis command — under the same `maxRetriesPerRequest: null`
      // constraint, it never resolves/rejects on its own if Redis is unreachable, which would
      // hang the whole app's shutdown indefinitely. Bound it and fall back to a hard disconnect
      // (no server round-trip needed) so shutdown always completes.
      await withTimeout(this.redis.quit(), this.cfg().redisOpTimeoutMs, 'redis quit');
    } catch {
      this.redis.disconnect();
    }
  }

  private getRedis(): Redis {
    if (!this.redis) {
      const rc = this.configService.get<ConfigType<typeof redisConfig>>('redis');
      this.redis = new Redis({
        host: rc?.host ?? '127.0.0.1',
        port: rc?.port ?? 6379,
        password: rc?.password,
        maxRetriesPerRequest: null,
        lazyConnect: true,
      });
      attachRedisLogging(this.redis, this.logger, 'inbound-admission');
      this.redis.connect().catch((err: unknown) => {
        this.logger.error(
          `Redis connect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return this.redis;
  }

  /** Current Redis connection status for this service — use to answer "is Redis working right
   *  now" without inferring it from admission behavior (which fails open on Redis errors). */
  getRedisStatus(): { status: string; healthy: boolean } {
    return redisStatusSummary(this.redis);
  }

  private cfg(): ConfigType<typeof callQueueConfig> {
    return (
      this.configService.get<ConfigType<typeof callQueueConfig>>('callQueue') ?? {
        maxConcurrentCalls: 50,
        maxConcurrentOutboundCalls: 10,
        maxConcurrentInboundCalls: 20,
        dialRateLimitPerWindow: 5,
        dialRateLimitWindowMs: 1000,
        retryLimit: 2,
        retryBackoffMs: 5000,
        callTimeoutMs: 10 * 60 * 1000,
        callStatusPollIntervalMs: 2000,
        dialAckTimeoutMs: 30_000,
        lockDurationMs: 30_000,
        stalledIntervalMs: 30_000,
        redisOpTimeoutMs: 2_000,
      }
    );
  }

  /**
   * Attempts to admit one inbound call before it's answered. Idempotent — re-admitting the same
   * `callSid` (e.g. a redelivered webhook) never double-counts it. Fails open (admits) if Redis
   * itself is unreachable, so an infra blip degrades to "no cap enforced" rather than rejecting
   * every inbound call.
   */
  async tryAdmit(callSid: string): Promise<InboundAdmissionResult> {
    const cfg = this.cfg();
    try {
      return await withTimeout(
        this.tryAdmitUnbounded(callSid, cfg),
        cfg.redisOpTimeoutMs,
        'tryAdmit',
      );
    } catch (err) {
      // Covers both a real Redis error AND the withTimeout bound tripping — ioredis, under
      // BullMQ's required `maxRetriesPerRequest: null`, retries a command forever while Redis is
      // unreachable rather than ever rejecting, so without this outer timeout a Redis outage would
      // hang every inbound call's admission check indefinitely instead of failing open.
      this.logger.warn(
        `[callId=${callSid}] Admission check failed (allowing call through): ${(err as Error).message}`,
      );
      return { admitted: true, activeInbound: -1, activeOutbound: -1 };
    }
  }

  private async tryAdmitUnbounded(
    callSid: string,
    cfg: ConfigType<typeof callQueueConfig>,
  ): Promise<InboundAdmissionResult> {
    const redis = this.getRedis();
    const now = Date.now();
    await redis.zremrangebyscore(ACTIVE_INBOUND_ZSET_KEY, '-inf', now);

    const activeInbound = await redis.zcard(ACTIVE_INBOUND_ZSET_KEY);
    const alreadyAdmitted = (await redis.zscore(ACTIVE_INBOUND_ZSET_KEY, callSid)) !== null;
    if (alreadyAdmitted) {
      return { admitted: true, activeInbound, activeOutbound: -1 };
    }

    if (activeInbound >= cfg.maxConcurrentInboundCalls) {
      this.logger.warn(
        `[callId=${callSid}] Rejected — inbound capacity exceeded (${String(activeInbound)}/${String(cfg.maxConcurrentInboundCalls)} active)`,
      );
      return { admitted: false, reason: 'inbound_capacity', activeInbound, activeOutbound: -1 };
    }

    const activeOutbound = await this.outboundCallQueue.getActiveCount().catch(() => 0);
    if (activeInbound + activeOutbound >= cfg.maxConcurrentCalls) {
      this.logger.warn(
        `[callId=${callSid}] Rejected — total call capacity exceeded (${String(activeInbound + activeOutbound)}/${String(cfg.maxConcurrentCalls)} active)`,
      );
      return { admitted: false, reason: 'total_capacity', activeInbound, activeOutbound };
    }

    await redis.zadd(ACTIVE_INBOUND_ZSET_KEY, 'NX', now + cfg.callTimeoutMs, callSid);
    this.logger.log(
      `[callId=${callSid}] Admitted (${String(activeInbound + 1)}/${String(cfg.maxConcurrentInboundCalls)} inbound, ${String(activeInbound + activeOutbound + 1)}/${String(cfg.maxConcurrentCalls)} total)`,
    );
    return { admitted: true, activeInbound: activeInbound + 1, activeOutbound };
  }

  /** Releases capacity held by a call once it ends. Safe to call even if it was never admitted
   *  (e.g. rejected calls, or admission checks that failed open) — a no-op in that case. */
  async release(callSid: string): Promise<void> {
    try {
      await withTimeout(
        this.getRedis().zrem(ACTIVE_INBOUND_ZSET_KEY, callSid),
        this.cfg().redisOpTimeoutMs,
        'release',
      );
    } catch (err) {
      this.logger.warn(
        `[callId=${callSid}] Failed to release inbound capacity: ${(err as Error).message}`,
      );
    }
  }
}
