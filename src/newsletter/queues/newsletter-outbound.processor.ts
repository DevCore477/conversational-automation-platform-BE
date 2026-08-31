import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Worker, type Job } from 'bullmq';
import { Repository } from 'typeorm';

import redisConfig from '../../configs/redis.config';
import { buildRedisConnectionOptions } from '../../whatsapp/queues/redis-connection.util';
import { EmailService } from '../../email/email.service';
import { NewsletterCampaign } from '../../models/newsletter/newsletter-campaign.entity';
import {
  NEWSLETTER_OUTBOUND_QUEUE,
  type NewsletterOutboundJobPayload,
} from '../types/newsletter-outbound.types';

@Injectable()
export class NewsletterOutboundProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsletterOutboundProcessor.name);
  private worker: Worker<NewsletterOutboundJobPayload> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    @InjectRepository(NewsletterCampaign)
    private readonly campaignRepo: Repository<NewsletterCampaign>,
  ) {}

  onModuleInit(): void {
    const rc = this.configService.get<ConfigType<typeof redisConfig>>('redis');
    const connection = buildRedisConnectionOptions({
      host: rc?.host,
      port: rc?.port,
      password: rc?.password,
    });

    this.worker = new Worker<NewsletterOutboundJobPayload>(
      NEWSLETTER_OUTBOUND_QUEUE,
      job => this.process(job),
      { connection, concurrency: 5 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.warn(`Newsletter job ${job?.id ?? 'unknown'} failed: ${err.message}`);
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.recordOutcome(job.data.campaignId, false);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<NewsletterOutboundJobPayload>): Promise<void> {
    const data = job.data;

    await this.emailService.sendMail({
      to: data.email,
      subject: data.subject,
      html: data.html,
      text: data.text,
    });

    await this.recordOutcome(data.campaignId, true);
  }

  private async recordOutcome(campaignId: string, sent: boolean): Promise<void> {
    await this.campaignRepo.increment({ id: campaignId }, sent ? 'sentCount' : 'failedCount', 1);

    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (campaign && campaign.sentCount + campaign.failedCount >= campaign.recipientCount) {
      await this.campaignRepo.update(campaignId, {
        status: 'completed',
        completedAt: new Date(),
      });
    }
  }
}
