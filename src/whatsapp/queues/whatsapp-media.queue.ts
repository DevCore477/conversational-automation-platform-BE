import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';

import redisConfig from '../../configs/redis.config';
import whatsappConfig from '../../configs/whatsapp.config';
import { WHATSAPP_MEDIA_QUEUE, type WhatsAppMediaJobPayload } from '../types/whatsapp-media.types';
import { buildRedisConnectionOptions } from './redis-connection.util';

@Injectable()
export class WhatsAppMediaQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppMediaQueueService.name);
  private queue: Queue<WhatsAppMediaJobPayload> | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    try {
      this.getQueue();
    } catch (err) {
      this.logger.warn(`WhatsApp media queue init deferred: ${(err as Error).message}`);
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

  getQueue(): Queue<WhatsAppMediaJobPayload> {
    if (!this.queue) {
      const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
      this.queue = new Queue(WHATSAPP_MEDIA_QUEUE, {
        connection: this.connectionOptions(),
        defaultJobOptions: {
          attempts: wa?.mediaMaxRetries ?? 3,
          backoff: { type: 'exponential', delay: wa?.mediaRetryBackoffMs ?? 4000 },
          removeOnComplete: 1000,
          removeOnFail: 2000,
        },
      });
    }
    return this.queue;
  }

  async enqueue(payload: WhatsAppMediaJobPayload): Promise<string> {
    // No colons: BullMQ rejects a custom jobId containing ':' unless it splits into exactly 3
    // segments (reserved for repeatable-job ids) — see Job.validateOptions.
    const job = await this.getQueue().add('process', payload, {
      jobId: `wa-media-${payload.mediaRowId}`,
    });
    return job.id ?? '';
  }
}
