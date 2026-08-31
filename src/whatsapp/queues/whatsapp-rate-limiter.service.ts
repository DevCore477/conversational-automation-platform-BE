import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';

import redisConfig from '../../configs/redis.config';
import whatsappConfig from '../../configs/whatsapp.config';
import { CompanyWhatsAppConfig } from '../../models/whatsapp/company-whatsapp-config.entity';

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

@Injectable()
export class WhatsAppRateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppRateLimiterService.name);
  private redis: Redis | null = null;

  constructor(private readonly configService: ConfigService) {}

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
      this.redis.connect().catch(err => {
        this.logger.error(`Redis connect failed: ${(err as Error).message}`);
      });
    }
    return this.redis;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }

  async check(companyId: string, config: CompanyWhatsAppConfig): Promise<RateLimitResult> {
    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const perSecond = config.maxMessagesPerSecond ?? wa?.maxMessagesPerSecond ?? 5;
    const perMinute = config.maxMessagesPerMinute ?? wa?.maxMessagesPerMinute ?? 80;
    const dailyMax = config.maxDailyMessages;

    try {
      const redis = this.getRedis();
      const secKey = `wa:rl:${companyId}:s:${Math.floor(Date.now() / 1000)}`;
      const minKey = `wa:rl:${companyId}:m:${Math.floor(Date.now() / 60000)}`;
      const dayKey = `wa:rl:${companyId}:d:${new Date().toISOString().slice(0, 10)}`;

      const secCount = await redis.incr(secKey);
      if (secCount === 1) {
        await redis.expire(secKey, 2);
      }
      if (secCount > perSecond) {
        return { allowed: false, reason: 'per_second_limit', retryAfterMs: 1000 };
      }

      const minCount = await redis.incr(minKey);
      if (minCount === 1) {
        await redis.expire(minKey, 120);
      }
      if (minCount > perMinute) {
        return { allowed: false, reason: 'per_minute_limit', retryAfterMs: 60_000 };
      }

      if (dailyMax != null && dailyMax > 0) {
        const dayCount = await redis.incr(dayKey);
        if (dayCount === 1) {
          await redis.expire(dayKey, 86_400);
        }
        if (dayCount > dailyMax) {
          return { allowed: false, reason: 'daily_limit', retryAfterMs: 3_600_000 };
        }
      }

      return { allowed: true };
    } catch (err) {
      this.logger.warn(`Rate limit check failed (allowing send): ${(err as Error).message}`);
      return { allowed: true };
    }
  }
}
