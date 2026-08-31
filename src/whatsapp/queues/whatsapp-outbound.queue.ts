import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';

import redisConfig from '../../configs/redis.config';
import whatsappConfig from '../../configs/whatsapp.config';
import {
  WHATSAPP_OUTBOUND_QUEUE,
  type WhatsAppOutboundJobPayload,
} from '../types/whatsapp-outbound.types';
import { buildRedisConnectionOptions } from './redis-connection.util';

@Injectable()
export class WhatsAppOutboundQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppOutboundQueueService.name);
  private queue: Queue<WhatsAppOutboundJobPayload> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      this.getQueue();
    } catch (err) {
      this.logger.warn(`WhatsApp outbound queue init deferred: ${(err as Error).message}`);
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

  getQueue(): Queue<WhatsAppOutboundJobPayload> {
    if (!this.queue) {
      this.queue = new Queue(WHATSAPP_OUTBOUND_QUEUE, {
        connection: this.connectionOptions(),
        defaultJobOptions: this.defaultJobOptions(),
      });
    }
    return this.queue;
  }

  private defaultJobOptions() {
    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const attempts = wa?.maxRetries ?? 5;
    const backoff = wa?.retryBackoffMs ?? 5000;
    return {
      attempts,
      backoff: { type: 'exponential' as const, delay: backoff },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    };
  }

  async enqueue(
    payload: WhatsAppOutboundJobPayload,
    opts?: { delayMs?: number; priority?: number },
  ): Promise<string> {
    const job = await this.getQueue().add('send', payload, {
      delay: opts?.delayMs,
      priority: opts?.priority ?? payload.priority ?? 0,
      jobId: `wa:${payload.companyId}:${payload.messageLogId}`,
    });
    return job.id ?? '';
  }

  async enqueueMany(
    items: { payload: WhatsAppOutboundJobPayload; delayMs?: number; priority?: number }[],
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.getQueue().addBulk(
      items.map((item, index) => ({
        name: 'send',
        data: item.payload,
        opts: {
          delay: item.delayMs ?? index * 800,
          priority: item.priority ?? 0,
          jobId: `wa:${item.payload.companyId}:${item.payload.messageLogId}`,
          ...this.defaultJobOptions(),
        },
      })),
    );
  }
}
