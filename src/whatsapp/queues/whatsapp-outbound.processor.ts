import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MetaWhatsAppApiError } from '../../clients/whatsapp/meta-whatsapp.client';
import { WHATSAPP_PERMANENT_ERROR_CODES } from '../../common/enums/whatsapp.enum';
import redisConfig from '../../configs/redis.config';
import whatsappConfig from '../../configs/whatsapp.config';
import { buildRedisConnectionOptions } from './redis-connection.util';
import {
  WHATSAPP_OUTBOUND_QUEUE,
  type WhatsAppOutboundJobPayload,
} from '../types/whatsapp-outbound.types';
import { WhatsAppConfigService } from '../services/whatsapp-config.service';
import { WhatsAppContactService } from '../services/whatsapp-contact.service';
import { WhatsAppConversationService } from '../services/whatsapp-conversation.service';
import { WhatsAppMessageLogService } from '../services/whatsapp-message-log.service';
import { WhatsAppRateLimiterService } from './whatsapp-rate-limiter.service';
import { WhatsAppCampaign } from '../../models/whatsapp/whatsapp-campaign.entity';
import { buildTemplateMessagePreview } from '../utils/whatsapp-message-display.util';

@Injectable()
export class WhatsAppOutboundProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppOutboundProcessor.name);
  private worker: Worker<WhatsAppOutboundJobPayload> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly configServiceWa: WhatsAppConfigService,
    private readonly rateLimiter: WhatsAppRateLimiterService,
    private readonly messageLog: WhatsAppMessageLogService,
    private readonly contactService: WhatsAppContactService,
    private readonly conversationService: WhatsAppConversationService,
    @InjectRepository(WhatsAppCampaign)
    private readonly campaignRepo: Repository<WhatsAppCampaign>,
  ) {}

  onModuleInit(): void {
    const rc = this.configService.get<ConfigType<typeof redisConfig>>('redis');
    const connection = buildRedisConnectionOptions({
      host: rc?.host,
      port: rc?.port,
      password: rc?.password,
    });

    const wa = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const concurrency = Math.min(wa?.maxMessagesPerSecond ?? 5, 10);

    this.worker = new Worker<WhatsAppOutboundJobPayload>(
      WHATSAPP_OUTBOUND_QUEUE,
      job => this.process(job),
      { connection, concurrency },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.warn(`Outbound job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<WhatsAppOutboundJobPayload>): Promise<void> {
    const data = job.data;
    const companyConfig = await this.configServiceWa.getActiveConfigOrThrow(data.companyId);

    const rate = await this.rateLimiter.check(data.companyId, companyConfig);
    if (!rate.allowed) {
      throw new Error(`Rate limited (${rate.reason})`);
    }

    const contact = await this.contactService.findById(data.companyId, data.contactId);
    if (!contact) {
      await this.messageLog.markFailed(data.messageLogId, '404', 'Contact not found');
      await this.recordCampaignSendOutcome(data.campaignId, false);
      return;
    }

    const eligibility = this.contactService.checkEligibility(contact);
    if (!eligibility.eligible) {
      await this.messageLog.markFailed(
        data.messageLogId,
        'skip',
        eligibility.skipReason ?? 'not_eligible',
      );
      await this.recordCampaignSendOutcome(data.campaignId, false);
      return;
    }

    if (data.conversationId) {
      const conv = await this.conversationService.getForCompany(
        data.companyId,
        data.conversationId,
      );
      if (conv && data.messageType === 'text') {
        this.conversationService.assertFreeformAllowed(conv);
      }
    }

    const client = this.configServiceWa.createMetaClient(companyConfig);

    try {
      let result;
      if (data.messageType === 'template') {
        if (!data.templateName) {
          throw new Error('templateName required');
        }
        result = await client.sendTemplate({
          to: data.phoneNumber,
          contentSid: data.templateName,
          templateName: data.templateName,
          languageCode: data.templateLanguage,
          parameters: data.templateParams,
          contentVariables: data.templateContentVariables,
          templateComponents: data.templateComponents,
        });
      } else {
        result = await client.sendText({
          to: data.phoneNumber,
          body: data.messageBody ?? '',
        });
      }

      if (result.messageSid) {
        await this.messageLog.markSent(data.messageLogId, result.messageSid);
      }

      const previewBody = buildTemplateMessagePreview(
        data.templateBodyPreview,
        {
          parameters: data.templateParams,
          contentVariables: data.templateContentVariables,
        },
        data.templateName,
      );
      if (previewBody) {
        await this.messageLog.updateMessageBody(data.messageLogId, previewBody);
      }

      await this.recordCampaignSendOutcome(data.campaignId, true);
    } catch (err: unknown) {
      const code = err instanceof MetaWhatsAppApiError && err.code != null ? err.code : undefined;
      const msg = (err as Error).message ?? String(err);
      await this.messageLog.markFailed(
        data.messageLogId,
        code != null ? String(code) : undefined,
        msg,
      );

      if (code != null && WHATSAPP_PERMANENT_ERROR_CODES.has(code)) {
        if (code === 131026) {
          await this.contactService.markBlocked(data.companyId, data.contactId);
        }
        await this.recordCampaignSendOutcome(data.campaignId, false);
        return;
      }

      throw err;
    }
  }

  private async recordCampaignSendOutcome(
    campaignId: string | undefined,
    sent: boolean,
  ): Promise<void> {
    if (!campaignId) {
      return;
    }

    await this.campaignRepo.increment({ id: campaignId }, sent ? 'sentCount' : 'failedCount', 1);
    await this.messageLog.refreshCampaignCompletion(campaignId);
  }
}
