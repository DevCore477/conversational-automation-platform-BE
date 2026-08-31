import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MetaWhatsAppClient } from '../../clients/whatsapp/meta-whatsapp.client';
import { WHATSAPP_CLIENT, type WhatsAppClientLike } from '../../clients/whatsapp/whatsapp.provider';
import {
  WhatsAppCampaignStatus,
  WhatsAppJobType,
  WhatsAppMessageDirection,
} from '../../common/enums/whatsapp.enum';
import whatsappConfig from '../../configs/whatsapp.config';
import { WhatsAppCampaign } from '../../models/whatsapp/whatsapp-campaign.entity';
import { WhatsAppJob } from '../../models/whatsapp/whatsapp-job.entity';
import type { WhatsAppMessageDesign } from '../types/message-design.types';
import { resolveDesignOutboundStorage } from '../utils/whatsapp-outbound-storage.util';
import { WhatsAppTemplateService } from './whatsapp-template.service';
import { WhatsAppMessageBuilderService } from '../whatsapp-message-builder.service';
import { WhatsAppChatService } from './whatsapp-chat.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import { WhatsAppConversationEngineService } from './whatsapp-conversation-engine.service';
import { WhatsAppInboundConfigService } from './whatsapp-inbound-config.service';
import { WhatsAppMessageLogService } from './whatsapp-message-log.service';
import { WhatsAppQueueService } from './whatsapp-queue.service';
import {
  enrichRoutingFromConversation,
  resolveConversationRouting,
} from '../utils/whatsapp-reply-routing.util';

@Injectable()
export class WhatsAppQueueProcessor {
  private readonly logger = new Logger(WhatsAppQueueProcessor.name);
  private processing = false;

  constructor(
    private readonly queueService: WhatsAppQueueService,
    private readonly chatService: WhatsAppChatService,
    private readonly messageLog: WhatsAppMessageLogService,
    private readonly inboundConfig: WhatsAppInboundConfigService,
    private readonly conversationEngine: WhatsAppConversationEngineService,
    private readonly messageBuilder: WhatsAppMessageBuilderService,
    @Inject(WHATSAPP_CLIENT) private readonly waClient: WhatsAppClientLike | null,
    private readonly configService: ConfigService,
    @InjectRepository(WhatsAppCampaign)
    private readonly campaignRepo: Repository<WhatsAppCampaign>,
    private readonly templateService: WhatsAppTemplateService,
    private readonly waConfigService: WhatsAppConfigService,
  ) {}

  /**
   * Resolves the Meta client for the conversation's own company/phone number, falling back to
   * the single globally-configured client only when no per-company config exists.
   *
   * IMPORTANT: `waClient` (WHATSAPP_CLIENT) is a single global client bound to whatever
   * WHATSAPP_META_PHONE_NUMBER_ID is set at boot — in a multi-tenant deployment that is almost
   * never the right number for a given conversation's company. Sending through the wrong number
   * silently fails (or "succeeds" against a number the customer never messaged), which is why
   * replies looked sent in our logs but were never delivered to the actual customer.
   */
  private async resolveClientForCompany(companyId?: string | null): Promise<WhatsAppClientLike | null> {
    if (!companyId) {
      return this.waClient;
    }
    try {
      const config = await this.waConfigService.getActiveConfigOrThrow(companyId);
      return this.waConfigService.createMetaClient(config);
    } catch (err) {
      this.logger.warn(
        `No active WhatsApp config for company ${companyId}, falling back to global client: ${(err as Error).message}`,
      );
      return this.waClient;
    }
  }

  @Interval(2000)
  async poll(): Promise<void> {
    const cfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      const batch = await this.queueService.claimBatch(cfg?.queueBatchSize ?? 20);
      await Promise.all(batch.map(job => this.processJob(job, cfg?.queueRetryBackoffMs ?? 5000)));
    } catch (err) {
      this.logger.error(`Queue poll error: ${(err as Error).message}`);
    } finally {
      this.processing = false;
    }
  }

  private async processJob(job: WhatsAppJob, retryBackoffMs: number): Promise<void> {
    try {
      switch (job.jobType) {
        case WhatsAppJobType.INBOUND_REPLY:
          await this.processInboundReply(job);
          break;
        case WhatsAppJobType.OUTBOUND_SEND:
        case WhatsAppJobType.BULK_SEND:
          await this.processOutboundSend(job);
          break;
        case WhatsAppJobType.MARK_READ:
          await this.processMarkRead(job);
          break;
        default:
          this.logger.warn(`Unknown job type ${String(job.jobType)}`);
      }
      await this.queueService.complete(job.id);
      if (job.campaignId) {
        await this.refreshCampaign(job.campaignId);
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.warn(`Job ${job.id} (${job.jobType}) failed: ${msg}`);
      await this.queueService.fail(job.id, msg, retryBackoffMs);
      if (job.campaignId) {
        await this.campaignRepo.increment({ id: job.campaignId }, 'failedCount', 1);
        await this.refreshCampaign(job.campaignId);
      }
    }
  }

  private async processInboundReply(job: WhatsAppJob): Promise<void> {
    const payload = job.payload;
    const conversationId = job.conversationId;
    const userText = String(payload.userText ?? '');
    const metaPhoneNumberId = String(payload.metaPhoneNumberId ?? '');
    const mediaRowId = typeof payload.mediaRowId === 'string' ? payload.mediaRowId : undefined;

    if (!conversationId) {
      throw new Error('inbound_reply missing conversationId');
    }

    const conversation = await this.chatService.getConversation(conversationId);
    if (!conversation) {
      throw new Error('conversation not found');
    }

    const fallbackRouting = await this.inboundConfig.resolve(metaPhoneNumberId);
    const routing = enrichRoutingFromConversation(
      conversation,
      resolveConversationRouting(conversation, fallbackRouting),
    );

    const messages = await this.chatService.listMessages(conversationId, 50);
    const hasOutbound = messages.some(m => m.direction === WhatsAppMessageDirection.OUTBOUND);

    let toSend: string;
    if (!userText.trim() && !mediaRowId) {
      toSend =
        (await this.conversationEngine.getGreetingIfNeeded(conversation, routing)) ??
        'Hello! How can I help you?';
    } else if (!hasOutbound) {
      const greeting = await this.conversationEngine.getGreetingIfNeeded(conversation, routing);
      const reply = await this.conversationEngine.generateReply(conversation, userText, routing, mediaRowId);
      toSend = greeting ? `${greeting}\n\n${reply}` : reply;
    } else {
      toSend = await this.conversationEngine.generateReply(conversation, userText, routing, mediaRowId);
    }

    await this.sendTextReply(conversationId, conversation.contactPhone, toSend, conversation.companyId);
  }

  private async processOutboundSend(job: WhatsAppJob): Promise<void> {
    const payload = job.payload;
    const to = String(payload.to ?? '');
    const dryRun = payload.dryRun === true;

    if (dryRun) {
      return;
    }

    if (payload.design) {
      const design = payload.design as WhatsAppMessageDesign;
      const variables = payload.variables as Record<string, string> | undefined;
      if (!to) {
        throw new Error('bulk_send with design requires payload.to (phone number)');
      }

      const conversation = await this.resolveConversationForOutbound(job, to);
      let templateMeta: { templateId?: string; bodyPreview?: string | null } | null = null;
      if (design.type === 'template' && conversation.companyId) {
        const row = await this.templateService.findByMetaName(
          conversation.companyId,
          design.templateName,
        );
        if (row) {
          templateMeta = { templateId: row.id, bodyPreview: row.bodyPreview };
        }
      }
      const storage = resolveDesignOutboundStorage(design, variables, templateMeta);
      const existingLogId =
        typeof payload.messageLogId === 'string' ? payload.messageLogId : undefined;

      let pendingId = existingLogId;
      if (!pendingId) {
        const pending = await this.chatService.createOutboundPending({
          conversationId: conversation.id,
          body: storage.body,
          messageType: design.type,
          companyId: conversation.companyId,
          campaignId: job.campaignId,
          phoneNumber: conversation.contactPhone,
          templateName: storage.templateName,
          payload: storage.payload,
        });
        pendingId = pending.id;
      }

      const result = await this.messageBuilder.sendDesigned(
        design,
        conversation.contactPhone,
        variables,
      );
      if (result.messageSid && pendingId) {
        if (existingLogId) {
          await this.messageLog.markSent(pendingId, result.messageSid);
        } else {
          await this.chatService.attachOutboundWamid(pendingId, result.messageSid);
        }
      }
      return;
    }

    const body = String(payload.body ?? '');
    if (!to || !body) {
      throw new Error('outbound_send requires to and body');
    }

    if (job.conversationId) {
      const conversation = await this.chatService.getConversation(job.conversationId);
      await this.sendTextReply(job.conversationId, to, body, conversation?.companyId);
    } else {
      const conversation = await this.resolveConversationForOutbound(job, to);
      await this.sendTextReply(conversation.id, conversation.contactPhone, body, conversation.companyId);
    }
  }

  private async resolveConversationForOutbound(
    job: WhatsAppJob,
    to: string,
  ): Promise<{ id: string; contactPhone: string; companyId: string | null }> {
    if (job.conversationId) {
      const existing = await this.chatService.getConversation(job.conversationId);
      if (!existing) {
        throw new Error('conversation not found');
      }
      return {
        id: existing.id,
        contactPhone: existing.contactPhone,
        companyId: existing.companyId,
      };
    }

    const metaPhoneNumberId = this.resolveMetaPhoneNumberId(job);
    const companyId = await this.resolveCompanyId(job, metaPhoneNumberId);

    const conv = await this.chatService.findOrCreateConversation({
      contactPhone: to,
      metaPhoneNumberId,
      companyId,
    });

    return {
      id: conv.id,
      contactPhone: conv.contactPhone,
      companyId: conv.companyId,
    };
  }

  private resolveMetaPhoneNumberId(job: WhatsAppJob): string {
    const fromPayload = String(job.payload.metaPhoneNumberId ?? '').trim();
    if (fromPayload) {
      return fromPayload;
    }
    const cfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const fromEnv = cfg?.metaPhoneNumberId?.trim();
    if (!fromEnv) {
      throw new Error(
        'metaPhoneNumberId not set. Configure WHATSAPP_META_PHONE_NUMBER_ID or company WhatsApp config.',
      );
    }
    return fromEnv;
  }

  private async resolveCompanyId(
    job: WhatsAppJob,
    metaPhoneNumberId: string,
  ): Promise<string | null> {
    const fromPayload = job.payload.companyId;
    if (typeof fromPayload === 'string' && fromPayload) {
      return fromPayload;
    }

    if (job.campaignId) {
      const campaign = await this.campaignRepo.findOne({ where: { id: job.campaignId } });
      if (campaign?.companyId) {
        return campaign.companyId;
      }
    }

    const routing = await this.inboundConfig.resolve(metaPhoneNumberId);
    return routing.companyId;
  }

  private async processMarkRead(job: WhatsAppJob): Promise<void> {
    const wamid = String(job.payload.metaWamid ?? '');
    if (!wamid) {
      return;
    }
    const companyId = typeof job.payload.companyId === 'string' ? job.payload.companyId : undefined;
    const client = await this.resolveClientForCompany(companyId);
    if (!(client instanceof MetaWhatsAppClient)) {
      return;
    }
    await client.markMessageAsRead(wamid);
    await this.chatService.markInboundReadByWamid(wamid);
  }

  private async sendTextReply(
    conversationId: string,
    to: string,
    body: string,
    companyId?: string | null,
  ): Promise<void> {
    const client = await this.resolveClientForCompany(companyId);
    if (!client) {
      throw new Error('WhatsApp client not configured');
    }

    const pending = await this.chatService.createOutboundPending({
      conversationId,
      body,
    });

    const result = await client.sendText({ to, body });
    if (result.messageSid) {
      await this.chatService.attachOutboundWamid(pending.id, result.messageSid);
    }
  }

  private async refreshCampaign(campaignId: string): Promise<void> {
    const stats = await this.queueService.getCampaignStats(campaignId);
    const pending = (stats.pending ?? 0) + (stats.processing ?? 0);
    const failed = stats.failed ?? 0;
    const completed = stats.completed ?? 0;
    const total = pending + failed + completed + (stats.cancelled ?? 0);

    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!campaign) {
      return;
    }

    campaign.sentCount = completed;
    campaign.failedCount = failed;
    if (pending === 0) {
      campaign.status = WhatsAppCampaignStatus.COMPLETED;
      campaign.completedAt = new Date();
    } else {
      campaign.status = WhatsAppCampaignStatus.RUNNING;
    }
    await this.campaignRepo.save(campaign);
  }
}
