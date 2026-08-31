import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';

import redisConfig from '../../configs/redis.config';
import { buildRedisConnectionOptions } from '../../whatsapp/queues/redis-connection.util';
import {
  NEWSLETTER_OUTBOUND_QUEUE,
  type NewsletterOutboundJobPayload,
} from '../types/newsletter-outbound.types';

@Injectable()
export class NewsletterOutboundQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsletterOutboundQueueService.name);
  private queue: Queue<NewsletterOutboundJobPayload> | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    try {
      this.getQueue();
    } catch (err) {
      this.logger.warn(`Newsletter outbound queue init deferred: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  private connectionOptions() {
    const rc = this.configService.get<ConfigType<typeof redisConfig>>('redis');
    return buildRedisConnectionOptions({
      host: rc?.host,
      port: rc?.port,
      password: rc?.password,
    });
  }

  getQueue(): Queue<NewsletterOutboundJobPayload> {
    this.queue ??= new Queue(NEWSLETTER_OUTBOUND_QUEUE, {
      connection: this.connectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    return this.queue;
  }

  async enqueueMany(items: NewsletterOutboundJobPayload[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.getQueue().addBulk(
      items.map((payload, index) => ({
        name: 'send',
        data: payload,
        opts: {
          delay: index * 200,
          jobId: `newsletter:${payload.campaignId}:${payload.subscriberId}`,
        },
      })),
    );
  }
}
