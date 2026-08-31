import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';

import {
  WhatsAppConversationStatus,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from '../../common/enums/whatsapp.enum';
import { normalizePhoneNumber } from '../../common/utils/phone.util';
import { WhatsAppConversation } from '../../models/whatsapp/whatsapp-conversation.entity';
import { WhatsAppMessage } from '../../models/whatsapp/whatsapp-message.entity';
import { WhatsAppMessageMedia } from '../../models/whatsapp/whatsapp-message-media.entity';
import {
  extractMessageTemplateParameterValues,
  extractTemplatePlaceholderNames,
  extractTemplateSendVarsFromPayload,
  resolveMessageDisplayBody,
  toTemplateDisplayInfo,
  type TemplateDisplayInfo,
} from '../utils/whatsapp-message-display.util';
import {
  mapMetaWebhookStatus,
  normalizeMetaWamid,
  shouldApplyStatusUpdate,
} from '../utils/whatsapp-message-status.util';
import type { WhatsAppReplyRoutingConfig } from '../types/whatsapp-reply-routing.types';
import { WhatsAppTemplateService } from './whatsapp-template.service';

export interface WhatsAppMessageMediaDisplay {
  mediaType: WhatsAppMessageMedia['mediaType'];
  status: WhatsAppMessageMedia['status'];
  s3Url: string | null;
  visionDescription: string | null;
  ocrText: string | null;
  sceneSummary: string | null;
  transcript: string | null;
  extractedText: string | null;
  structuredData: WhatsAppMessageMedia['structuredData'];
  errorMessage: string | null;
}

export type WhatsAppMessageWithDisplay = WhatsAppMessage & {
  template: TemplateDisplayInfo | null;
  /** Ordered values sent as template body parameters for this message. */
  templateParameters: string[];
  /** Media understanding output (image/video/audio/document analysis), when this message carries media. */
  media: WhatsAppMessageMediaDisplay | null;
};

@Injectable()
export class WhatsAppChatService {
  private readonly logger = new Logger(WhatsAppChatService.name);

  constructor(
    @InjectRepository(WhatsAppConversation)
    private readonly conversationRepo: Repository<WhatsAppConversation>,
    @InjectRepository(WhatsAppMessage)
    private readonly messageRepo: Repository<WhatsAppMessage>,
    @InjectRepository(WhatsAppMessageMedia)
    private readonly mediaRepo: Repository<WhatsAppMessageMedia>,
    private readonly templateService: WhatsAppTemplateService,
  ) {}

  async findOrCreateConversation(params: {
    contactPhone: string;
    contactWaId?: string;
    metaPhoneNumberId: string;
    companyId?: string | null;
    routingMode?: string;
    agentId?: string | null;
    flowId?: string | null;
    scriptId?: string | null;
    sessionState?: WhatsAppConversation['sessionState'];
  }): Promise<WhatsAppConversation> {
    const contactPhone = normalizePhoneNumber(params.contactPhone);
    const where: FindOptionsWhere<WhatsAppConversation> = {
      metaPhoneNumberId: params.metaPhoneNumberId,
      contactPhone,
    };
    if (params.companyId) {
      where.companyId = params.companyId;
    }
    let conv = await this.conversationRepo.findOne({ where });

    if (!conv) {
      conv = this.conversationRepo.create({
        contactPhone,
        contactWaId: params.contactWaId ?? null,
        metaPhoneNumberId: params.metaPhoneNumberId,
        companyId: params.companyId ?? null,
        routingMode: params.routingMode ?? null,
        agentId: params.agentId ?? null,
        flowId: params.flowId ?? null,
        scriptId: params.scriptId ?? null,
        sessionState: params.sessionState ?? null,
        status: 'open',
      });
      conv = await this.conversationRepo.save(conv);
      this.logger.log(`Created WhatsApp conversation ${conv.id} for ${contactPhone}`);
    } else if (conv.deletedAt) {
      await this.conversationRepo.update(conv.id, { deletedAt: null, status: 'open' });
      conv.deletedAt = null;
      conv.status = 'open';
    }

    return conv;
  }

  async saveInboundMessage(params: {
    conversationId: string;
    companyId?: string | null;
    contactId?: string | null;
    phoneNumber?: string;
    metaWamid: string;
    body?: string;
    messageType?: string;
    mediaUrl?: string;
    payload?: Record<string, unknown>;
  }): Promise<WhatsAppMessage | null> {
    const existing = await this.messageRepo.findOne({
      where: { metaWamid: params.metaWamid },
    });
    if (existing) {
      return existing;
    }

    const msg = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: params.conversationId,
        companyId: params.companyId ?? null,
        contactId: params.contactId ?? null,
        phoneNumber: params.phoneNumber ?? null,
        direction: WhatsAppMessageDirection.INBOUND,
        messageType: params.messageType ?? 'text',
        body: params.body ?? null,
        mediaUrl: params.mediaUrl ?? null,
        metaWamid: params.metaWamid,
        status: WhatsAppMessageStatus.RECEIVED,
        statusUpdatedAt: new Date(),
        payload: params.payload ?? null,
      }),
    );

    const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.conversationRepo.update(params.conversationId, {
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      serviceWindowExpiresAt: windowEnd,
      deletedAt: null,
    });
    await this.markOutboundReadByCustomerReply(params.conversationId);
    await this.syncUnreadCount(params.conversationId);
    await this.syncConversationLifecycle(params.conversationId, 'inbound_received');

    return msg;
  }

  async createOutboundPending(params: {
    conversationId: string;
    body: string;
    messageType?: string;
    companyId?: string | null;
    contactId?: string | null;
    campaignId?: string | null;
    phoneNumber?: string | null;
    templateName?: string | null;
    mediaUrl?: string | null;
    payload?: Record<string, unknown> | null;
    /** Bump conversation in inbox list immediately (bulk/campaign/single send). */
    touchConversation?: boolean;
  }): Promise<WhatsAppMessage> {
    const msg = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: params.conversationId,
        companyId: params.companyId ?? null,
        contactId: params.contactId ?? null,
        campaignId: params.campaignId ?? null,
        phoneNumber: params.phoneNumber ?? null,
        templateName: params.templateName ?? null,
        mediaUrl: params.mediaUrl ?? null,
        payload: params.payload ?? null,
        direction: WhatsAppMessageDirection.OUTBOUND,
        messageType: params.messageType ?? 'text',
        body: params.body,
        status: WhatsAppMessageStatus.PENDING,
        statusUpdatedAt: new Date(),
      }),
    );

    if (params.touchConversation !== false) {
      await this.touchOutboundActivity(params.conversationId);
    }

    return msg;
  }

  async touchOutboundActivity(conversationId: string): Promise<void> {
    const now = new Date();
    await this.conversationRepo.update(conversationId, {
      lastMessageAt: now,
      lastOutboundAt: now,
      deletedAt: null,
    });
  }

  /**
   * After Meta Graph API returns a WAMID — message is accepted, not yet webhook-confirmed as sent.
   */
  async attachOutboundWamid(messageId: string, metaWamid: string): Promise<void> {
    const normalizedWamid = normalizeMetaWamid(metaWamid);
    if (!normalizedWamid) {
      this.logger.warn(`attachOutboundWamid: empty wamid for message ${messageId}`);
      return;
    }

    const msg = await this.messageRepo.findOne({ where: { id: messageId } });
    const now = new Date();
    await this.messageRepo.update(messageId, {
      metaWamid: normalizedWamid,
      status: WhatsAppMessageStatus.ACCEPTED,
      statusUpdatedAt: now,
    });
    if (msg?.conversationId) {
      await this.touchOutboundActivity(msg.conversationId);
    }
    this.logger.log(
      `Outbound accepted by Meta messageId=${messageId} wamid=${normalizedWamid} (awaiting sent/delivered webhooks)`,
    );
  }

  async updateMessageStatusByWamid(
    metaWamid: string,
    status: string,
    error?: { code?: string; message?: string },
  ): Promise<void> {
    await this.applyMetaDeliveryStatus(metaWamid, status, error);
  }

  async updateMessageStatusByWamidWithResult(
    metaWamid: string,
    status: string,
    error?: { code?: string; message?: string },
  ): Promise<Pick<WhatsAppMessage, 'id' | 'conversationId' | 'direction'> | null> {
    const msg = await this.applyMetaDeliveryStatus(metaWamid, status, error);
    if (!msg) {
      return null;
    }
    return {
      id: msg.id,
      conversationId: msg.conversationId,
      direction: msg.direction,
    };
  }

  /**
   * Apply Meta webhook delivery status (sent → delivered → read / failed) to a stored message.
   */
  async applyMetaDeliveryStatus(
    metaWamid: string,
    metaStatus: string,
    error?: { code?: string; message?: string },
  ): Promise<WhatsAppMessage | null> {
    const wamid = normalizeMetaWamid(metaWamid);
    if (!wamid) {
      return null;
    }

    const msg = await this.messageRepo.findOne({ where: { metaWamid: wamid } });
    if (!msg) {
      this.logger.warn(
        `Meta status "${metaStatus}" for unknown wamid=${wamid} — check webhook URL/subscriptions and that outbound logging stores the same WAMID`,
      );
      return null;
    }

    const mapped = mapMetaWebhookStatus(metaStatus);
    const direction = msg.direction === WhatsAppMessageDirection.INBOUND ? 'inbound' : 'outbound';

    if (!shouldApplyStatusUpdate(msg.status, mapped, direction)) {
      this.logger.debug(
        `Ignoring non-progressive status wamid=${wamid} current=${msg.status} incoming=${mapped} (meta=${metaStatus})`,
      );
      return msg;
    }

    const now = new Date();
    const metaLower = metaStatus.toLowerCase();

    await this.messageRepo.update(msg.id, {
      status: mapped,
      statusUpdatedAt: now,
      ...(metaLower === 'sent' ? { sentAt: now } : {}),
      ...(metaLower === 'delivered' ? { deliveredAt: now } : {}),
      ...(metaLower === 'read' ? { readAt: now } : {}),
      ...(metaLower === 'failed'
        ? {
            failedAt: now,
            errorCode: error?.code ?? null,
            errorMessage: error?.message ?? null,
          }
        : {}),
    });

    this.logger.log(
      `Meta delivery status wamid=${wamid} ${msg.status} → ${mapped} messageId=${msg.id} conversationId=${msg.conversationId}`,
    );

    if (msg.direction === WhatsAppMessageDirection.OUTBOUND) {
      await this.conversationRepo.update(msg.conversationId, {
        lastMessageAt: now,
        lastOutboundAt: now,
      });
      if (mapped === WhatsAppMessageStatus.FAILED) {
        await this.syncConversationLifecycle(msg.conversationId, 'outbound_failed');
      }
    }

    if (
      msg.direction === WhatsAppMessageDirection.INBOUND &&
      mapped === WhatsAppMessageStatus.READ
    ) {
      await this.syncUnreadCount(msg.conversationId);
    }

    return msg;
  }

  /**
   * After Meta read receipt API succeeds — mark inbound as read and refresh conversation unread count.
   */
  async markInboundReadByWamid(metaWamid: string): Promise<void> {
    const msg = await this.messageRepo.findOne({ where: { metaWamid } });
    if (msg?.direction !== WhatsAppMessageDirection.INBOUND) {
      return;
    }
    if (msg.status === WhatsAppMessageStatus.READ) {
      await this.syncUnreadCount(msg.conversationId);
      return;
    }

    const now = new Date();
    await this.messageRepo.update(msg.id, {
      status: WhatsAppMessageStatus.READ,
      statusUpdatedAt: now,
      readAt: now,
    });
    await this.syncUnreadCount(msg.conversationId);
  }

  /**
   * When the customer sends a message they have typically seen prior outbound messages.
   * Meta may also send read webhooks; this keeps the inbox consistent immediately.
   */
  async markOutboundReadByCustomerReply(conversationId: string): Promise<void> {
    const now = new Date();
    await this.messageRepo.update(
      {
        conversationId,
        direction: WhatsAppMessageDirection.OUTBOUND,
        deletedAt: IsNull(),
        status: In([
          WhatsAppMessageStatus.PENDING,
          WhatsAppMessageStatus.QUEUED,
          WhatsAppMessageStatus.SENT,
          WhatsAppMessageStatus.DELIVERED,
        ]),
      },
      {
        status: WhatsAppMessageStatus.READ,
        statusUpdatedAt: now,
        readAt: now,
      },
    );
  }

  /** Count inbound messages not yet read by the business (agent inbox). */
  async syncUnreadCount(conversationId: string): Promise<number> {
    const count = await this.messageRepo.count({
      where: {
        conversationId,
        direction: WhatsAppMessageDirection.INBOUND,
        deletedAt: IsNull(),
        status: In([WhatsAppMessageStatus.RECEIVED]),
      },
    });

    try {
      await this.conversationRepo.update(conversationId, { unreadCount: count });
    } catch (err) {
      this.logger.warn(
        `Could not update unreadCount for conversation ${conversationId} — run migration add-whatsapp-unread-count.sql: ${(err as Error).message}`,
      );
    }

    return count;
  }

  async updateSessionState(
    conversationId: string,
    sessionState: WhatsAppConversation['sessionState'],
  ): Promise<void> {
    await this.conversationRepo.update(conversationId, {
      sessionState: sessionState as object,
    });
  }

  /** Pin reply routing on a conversation (e.g. from campaign/bulk send) and reset AI session. */
  async applyReplyRouting(
    conversationId: string,
    routing: WhatsAppReplyRoutingConfig,
  ): Promise<void> {
    const sessionSeed =
      routing.aiModel || routing.aiSystemPrompt
        ? {
            model: routing.aiModel,
            systemPrompt: routing.aiSystemPrompt ?? undefined,
          }
        : null;

    await this.conversationRepo.update(conversationId, {
      routingMode: routing.routingMode,
      agentId: routing.agentId ?? null,
      flowId: routing.flowId ?? null,
      scriptId: routing.scriptId ?? null,
      sessionState: sessionSeed,
      aiEnabled: true,
    });
  }

  /**
   * Unpins any previously-set routing (routingMode/agentId/flowId/scriptId/session) so the next
   * inbound message resolves fresh from the phone number's default WhatsAppInboundConfig. Called
   * automatically by `WhatsAppOutboundService` whenever a send doesn't specify routingMode (a send
   * with no routing is treated as "start fresh" for that conversation), and also exposed as a
   * standalone action via `resetReplyRoutingForCompany` for unpinning without sending anything.
   */
  async resetReplyRouting(conversationId: string): Promise<void> {
    await this.conversationRepo.update(conversationId, {
      routingMode: null,
      agentId: null,
      flowId: null,
      scriptId: null,
      sessionState: null,
    });
  }

  /** Company-scoped wrapper for the standalone "reset routing" admin/API action. */
  async resetReplyRoutingForCompany(
    companyId: string,
    conversationId: string,
  ): Promise<{ reset: true }> {
    const conv = await this.getConversationForCompany(companyId, conversationId);
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }
    await this.resetReplyRouting(conversationId);
    return { reset: true };
  }

  async getConversation(id: string): Promise<WhatsAppConversation | null> {
    return this.conversationRepo.findOne({ where: { id } });
  }

  async getConversationForCompany(
    companyId: string,
    id: string,
  ): Promise<WhatsAppConversation | null> {
    return this.conversationRepo.findOne({
      where: { id, companyId, deletedAt: IsNull() },
    });
  }

  async listMessagesByContact(companyId: string, contactId: string) {
    const convs = await this.conversationRepo.find({
      where: { companyId, contactId, deletedAt: IsNull() },
      order: { lastMessageAt: 'DESC' },
      take: 1,
    });
    const conv = convs[0];
    if (!conv) {
      return { conversation: null, messages: [] };
    }
    const messages = await this.listMessagesForDisplay(companyId, conv.id, 200);
    return { conversation: conv, messages };
  }

  async listMessagesByPhone(companyId: string, phone: string) {
    const contactPhone = normalizePhoneNumber(phone);
    if (!contactPhone) {
      return { conversation: null, messages: [] };
    }
    const convs = await this.conversationRepo.find({
      where: { companyId, contactPhone, deletedAt: IsNull() },
      order: { lastMessageAt: 'DESC' },
      take: 1,
    });
    const conv = convs[0];
    if (!conv) {
      return { conversation: null, messages: [] };
    }
    const messages = await this.listMessagesForDisplay(companyId, conv.id, 200);
    return { conversation: conv, messages };
  }

  async listConversations(params: {
    companyId?: string;
    limit?: number;
    offset?: number;
  }): Promise<WhatsAppConversation[]> {
    const result = await this.listConversationsPaginated({
      companyId: params.companyId ?? '',
      page: 1,
      limit: params.limit ?? 50,
      offset: params.offset,
    });
    return result.data;
  }

  async listConversationsPaginated(params: {
    companyId: string;
    page?: number;
    limit?: number;
    /** Legacy offset — if set, overrides page */
    offset?: number;
    status?: string;
    unreadOnly?: boolean;
    search?: string;
    contactId?: string;
    sortBy?: 'lastMessageAt' | 'createdAt' | 'unreadCount';
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<{
    data: WhatsAppConversation[];
    meta: {
      currentPage: number;
      itemsPerPage: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
  }> {
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const page =
      params.offset != null && params.offset >= 0
        ? Math.floor(params.offset / limit) + 1
        : Math.max(1, params.page ?? 1);
    const skip = (page - 1) * limit;

    const qb = this.conversationRepo
      .createQueryBuilder('c')
      .where('c.companyId = :companyId', { companyId: params.companyId })
      .andWhere('c.deletedAt IS NULL');

    if (params.status) {
      qb.andWhere('c.status = :status', { status: params.status });
    }

    if (params.unreadOnly === true) {
      qb.andWhere('c.unreadCount > 0');
    }

    if (params.contactId) {
      qb.andWhere('c.contactId = :contactId', { contactId: params.contactId });
    }

    if (params.search) {
      const term = params.search.replace(/\s+/g, '');
      const digits = term.replace(/\D/g, '');
      if (digits.length > 0) {
        qb.andWhere('c.contactPhone LIKE :phoneSearch', { phoneSearch: `%${digits}%` });
      } else {
        qb.andWhere('LOWER(c.contactPhone) LIKE LOWER(:textSearch)', {
          textSearch: `%${params.search}%`,
        });
      }
    }

    const sortOrder = params.sortOrder ?? 'DESC';
    switch (params.sortBy ?? 'lastMessageAt') {
      case 'createdAt':
        qb.orderBy('c.createdAt', sortOrder);
        break;
      case 'unreadCount':
        qb.orderBy('c.unreadCount', sortOrder).addOrderBy(
          'COALESCE(c.lastMessageAt, c.updatedAt, c.createdAt)',
          'DESC',
        );
        break;
      case 'lastMessageAt':
      default:
        qb.orderBy('COALESCE(c.lastMessageAt, c.updatedAt, c.createdAt)', sortOrder);
        break;
    }

    const [data, totalItems] = await qb.skip(skip).take(limit).getManyAndCount();
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return {
      data,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async listMessages(conversationId: string, limit = 100, offset = 0): Promise<WhatsAppMessage[]> {
    return this.messageRepo.find({
      where: { conversationId, deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
  }

  async listMessagesForDisplay(
    companyId: string | null | undefined,
    conversationId: string,
    limit = 100,
    offset = 0,
  ): Promise<WhatsAppMessageWithDisplay[]> {
    const messages = await this.listMessages(conversationId, limit, offset);
    return this.enrichMessagesForDisplay(companyId, messages);
  }

  async enrichMessagesForDisplay(
    companyId: string | null | undefined,
    messages: WhatsAppMessage[],
  ): Promise<WhatsAppMessageWithDisplay[]> {
    const templateCache = new Map<string, TemplateDisplayInfo>();
    const templateOrderCache = new Map<string, string[]>();
    const templateNames = [
      ...new Set(messages.map(m => m.templateName).filter((name): name is string => Boolean(name))),
    ];

    if (companyId) {
      await Promise.all(
        templateNames.map(async name => {
          const row = await this.templateService.findByMetaName(companyId, name);
          if (row) {
            templateCache.set(name, toTemplateDisplayInfo(row));
            templateOrderCache.set(
              name,
              extractTemplatePlaceholderNames(row.components, row.bodyPreview),
            );
          }
        }),
      );
    }

    const messageIds = messages.map(m => m.id);
    const mediaRows = messageIds.length
      ? await this.mediaRepo.find({ where: { messageId: In(messageIds) } })
      : [];
    const mediaByMessageId = new Map(mediaRows.map(m => [m.messageId, m]));

    return messages.map(msg => {
      const template =
        (msg.templateName ? templateCache.get(msg.templateName) : null) ??
        (msg.templateName
          ? {
              name: msg.templateName,
              metaTemplateName: msg.templateName,
              bodyPreview: null,
            }
          : null);
      const sendVars = extractTemplateSendVarsFromPayload(msg.payload);
      const orderHint = msg.templateName ? templateOrderCache.get(msg.templateName) : undefined;
      const media = mediaByMessageId.get(msg.id);

      return {
        ...msg,
        body: resolveMessageDisplayBody(msg.body, template, sendVars),
        template,
        templateParameters: extractMessageTemplateParameterValues(sendVars, orderHint),
        media: media
          ? {
              mediaType: media.mediaType,
              status: media.status,
              s3Url: media.s3Url,
              visionDescription: media.visionDescription,
              ocrText: media.ocrText,
              sceneSummary: media.sceneSummary,
              transcript: media.transcript,
              extractedText: media.extractedText,
              structuredData: media.structuredData,
              errorMessage: media.errorMessage,
            }
          : null,
      };
    });
  }

  async getMessageForCompany(
    companyId: string,
    messageId: string,
  ): Promise<WhatsAppMessage | null> {
    return this.messageRepo.findOne({
      where: { id: messageId, companyId, deletedAt: IsNull() },
    });
  }

  async markOutboundFailed(
    messageId: string,
    errorCode: string | undefined,
    errorMessage: string,
  ): Promise<void> {
    const msg = await this.messageRepo.findOne({ where: { id: messageId } });
    if (!msg) {
      return;
    }
    const now = new Date();
    await this.messageRepo.update(messageId, {
      status: WhatsAppMessageStatus.FAILED,
      statusUpdatedAt: now,
      failedAt: now,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage.slice(0, 2000),
    });
    if (msg.conversationId) {
      await this.touchOutboundActivity(msg.conversationId);
      await this.syncConversationLifecycle(msg.conversationId, 'outbound_failed');
    }
  }

  async resetMessageForRetry(messageId: string): Promise<void> {
    await this.messageRepo.update(messageId, {
      status: WhatsAppMessageStatus.PENDING,
      statusUpdatedAt: new Date(),
      metaWamid: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
    });
  }

  async updateConversationStatus(
    companyId: string,
    conversationId: string,
    status: WhatsAppConversationStatus,
  ): Promise<WhatsAppConversation> {
    const conv = await this.getConversationForCompany(companyId, conversationId);
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }
    conv.status = status;
    return this.conversationRepo.save(conv);
  }

  /**
   * Keeps conversation status in sync with inbox activity.
   * - Reopens on inbound when closed
   * - Stays open on outbound activity
   */
  async syncConversationLifecycle(
    conversationId: string,
    event:
      | 'inbound_received'
      | 'outbound_sent'
      | 'outbound_failed'
      | 'marked_closed'
      | 'marked_handoff',
  ): Promise<void> {
    const conv = await this.conversationRepo.findOne({ where: { id: conversationId } });
    if (!conv) {
      return;
    }

    if (event === 'inbound_received' && conv.status === WhatsAppConversationStatus.CLOSED) {
      await this.conversationRepo.update(conversationId, {
        status: WhatsAppConversationStatus.OPEN,
      });
      return;
    }

    if (event === 'outbound_sent' && conv.status === WhatsAppConversationStatus.CLOSED) {
      await this.conversationRepo.update(conversationId, {
        status: WhatsAppConversationStatus.OPEN,
      });
    }
  }

  async clearConversation(
    companyId: string,
    conversationId: string,
  ): Promise<{ deletedMessages: number; softDeleted: true }> {
    const conv = await this.conversationRepo.findOne({
      where: { id: conversationId, companyId, deletedAt: IsNull() },
    });
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }

    const now = new Date();
    const result = await this.messageRepo.update(
      { conversationId, deletedAt: IsNull() },
      { deletedAt: now },
    );
    await this.conversationRepo.update(conversationId, {
      deletedAt: now,
      unreadCount: 0,
      lastMessageAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    });

    this.logger.log(
      `Soft-deleted conversation ${conversationId} company=${companyId} messages=${result.affected ?? 0}`,
    );

    return { deletedMessages: result.affected ?? 0, softDeleted: true };
  }

  async deleteMessage(
    companyId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ deleted: true; softDeleted: true }> {
    const conv = await this.getConversationForCompany(companyId, conversationId);
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }

    const msg = await this.messageRepo.findOne({
      where: { id: messageId, conversationId, companyId, deletedAt: IsNull() },
    });
    if (!msg) {
      throw new NotFoundException('Message not found');
    }

    if (
      msg.status === WhatsAppMessageStatus.PENDING ||
      msg.status === WhatsAppMessageStatus.QUEUED
    ) {
      throw new BadRequestException('Cannot delete a message that is still sending');
    }

    const now = new Date();
    await this.messageRepo.update(msg.id, { deletedAt: now });
    await this.syncUnreadCount(conversationId);

    const latest = await this.messageRepo.findOne({
      where: { conversationId, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    await this.conversationRepo.update(conversationId, {
      lastMessageAt: latest?.createdAt ?? null,
    });

    return { deleted: true, softDeleted: true };
  }
}
