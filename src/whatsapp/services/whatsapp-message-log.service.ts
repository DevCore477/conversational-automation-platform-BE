import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  WhatsAppCampaignStatus,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from '../../common/enums/whatsapp.enum';
import { WhatsAppMessage } from '../../models/whatsapp/whatsapp-message.entity';
import { WhatsAppCampaign } from '../../models/whatsapp/whatsapp-campaign.entity';
import { WhatsAppChatService } from './whatsapp-chat.service';
import { shouldCompleteCampaign } from '../utils/campaign-completion.util';
import { normalizeMetaWamid } from '../utils/whatsapp-message-status.util';

@Injectable()
export class WhatsAppMessageLogService {
  private readonly logger = new Logger(WhatsAppMessageLogService.name);

  constructor(
    @InjectRepository(WhatsAppMessage)
    private readonly messageRepo: Repository<WhatsAppMessage>,
    @InjectRepository(WhatsAppCampaign)
    private readonly campaignRepo: Repository<WhatsAppCampaign>,
    private readonly chatService: WhatsAppChatService,
  ) {}

  async createQueuedOutbound(params: {
    companyId: string;
    contactId: string;
    conversationId: string;
    campaignId?: string;
    phoneNumber: string;
    messageType: string;
    body?: string;
    templateName?: string;
    payload?: Record<string, unknown> | null;
  }): Promise<WhatsAppMessage> {
    const msg = await this.messageRepo.save(
      this.messageRepo.create({
        companyId: params.companyId,
        contactId: params.contactId,
        conversationId: params.conversationId,
        campaignId: params.campaignId ?? null,
        phoneNumber: params.phoneNumber,
        direction: WhatsAppMessageDirection.OUTBOUND,
        messageType: params.messageType,
        body: params.body ?? null,
        templateName: params.templateName ?? null,
        payload: params.payload ?? null,
        status: WhatsAppMessageStatus.QUEUED,
        statusUpdatedAt: new Date(),
      }),
    );

    await this.chatService.touchOutboundActivity(params.conversationId);
    return msg;
  }

  async markSent(messageId: string, metaMessageId: string): Promise<void> {
    await this.chatService.attachOutboundWamid(messageId, metaMessageId);
  }

  async updateMessageBody(messageId: string, body: string): Promise<void> {
    await this.messageRepo.update(messageId, { body });
  }

  async markFailed(
    messageId: string,
    errorCode: string | undefined,
    errorMessage: string,
  ): Promise<void> {
    const msg = await this.messageRepo.findOne({ where: { id: messageId } });
    await this.messageRepo.update(messageId, {
      status: WhatsAppMessageStatus.FAILED,
      statusUpdatedAt: new Date(),
      failedAt: new Date(),
      errorCode: errorCode ?? null,
      errorMessage: errorMessage.slice(0, 2000),
    });
    if (msg?.conversationId) {
      await this.chatService.touchOutboundActivity(msg.conversationId);
      await this.chatService.syncConversationLifecycle(msg.conversationId, 'outbound_failed');
    }
  }

  async updateStatusByWamid(
    companyId: string,
    metaWamid: string,
    status: string,
    error?: { code?: string; message?: string },
  ): Promise<WhatsAppMessage | null> {
    const wamid = normalizeMetaWamid(metaWamid);
    if (!wamid) {
      return null;
    }

    const msg = await this.chatService.applyMetaDeliveryStatus(wamid, status, error);
    if (!msg) {
      return null;
    }

    if (msg.companyId && msg.companyId !== companyId) {
      this.logger.warn(
        `Status wamid=${wamid} belongs to company ${msg.companyId}, webhook company ${companyId}`,
      );
    }

    if (msg.campaignId) {
      await this.incrementCampaignStat(msg.campaignId, status);
      await this.refreshCampaignCompletion(msg.campaignId);
    }

    return msg;
  }

  /** Mark campaign completed once every queued outbound message is delivered, read, or failed. */
  async refreshCampaignCompletion(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (campaign?.status !== WhatsAppCampaignStatus.SENDING || campaign.queuedCount <= 0) {
      return;
    }

    const terminalCount = await this.messageRepo.count({
      where: {
        campaignId,
        direction: WhatsAppMessageDirection.OUTBOUND,
        status: In([
          WhatsAppMessageStatus.DELIVERED,
          WhatsAppMessageStatus.READ,
          WhatsAppMessageStatus.FAILED,
        ]),
      },
    });

    if (!shouldCompleteCampaign(campaign.status, campaign.queuedCount, terminalCount)) {
      return;
    }

    // mark failed if the campaign has all messages as failed, otherwise completed
    if (terminalCount === campaign.queuedCount) {
      campaign.status = WhatsAppCampaignStatus.FAILED;
    } else {
      campaign.status = WhatsAppCampaignStatus.COMPLETED;
    }
    campaign.completedAt = new Date();
    await this.campaignRepo.save(campaign);

    this.logger.log(
      `Campaign ${campaignId} completed (${String(terminalCount)}/${String(campaign.queuedCount)} recipients in terminal state)`,
    );
  }

  private async incrementCampaignStat(campaignId: string, status: string): Promise<void> {
    if (status === 'delivered') {
      await this.campaignRepo.increment({ id: campaignId }, 'deliveredCount', 1);
    } else if (status === 'read') {
      await this.campaignRepo.increment({ id: campaignId }, 'readCount', 1);
    } else if (status === 'failed') {
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
    }
  }
}
