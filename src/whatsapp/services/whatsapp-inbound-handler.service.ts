import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MetaWhatsAppClient } from '../../clients/whatsapp/meta-whatsapp.client';
import { WHATSAPP_CLIENT, type WhatsAppClientLike } from '../../clients/whatsapp/whatsapp.provider';
import {
  WhatsAppJobType,
  WhatsAppMediaKind,
  WhatsAppMediaProcessingStatus,
} from '../../common/enums/whatsapp.enum';
import { normalizePhoneNumber } from '../../common/utils/phone.util';
import { WhatsAppMessageMedia } from '../../models/whatsapp/whatsapp-message-media.entity';
import { WhatsAppMediaQueueService } from '../queues/whatsapp-media.queue';
import { WhatsAppChatService } from './whatsapp-chat.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import { WhatsAppContactService } from './whatsapp-contact.service';
import { WhatsAppConversationService } from './whatsapp-conversation.service';
import { WhatsAppInboundConfigService } from './whatsapp-inbound-config.service';
import { WhatsAppMessageLogService } from './whatsapp-message-log.service';
import { WhatsAppOptOutService } from './whatsapp-optout.service';
import { WhatsAppQueueService } from './whatsapp-queue.service';

export interface MetaInboundMessage {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  sticker?: { id?: string; mime_type?: string; animated?: boolean };
  video?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: {
    name?: { formatted_name?: string };
    phones?: { phone?: string; wa_id?: string }[];
  }[];
}

export interface MetaStatusUpdate {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: {
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }[];
}

/** Message types that carry media/structured content understood by the multimodal pipeline. */
const MEDIA_MESSAGE_KIND: Record<string, WhatsAppMediaKind | undefined> = {
  image: WhatsAppMediaKind.IMAGE,
  sticker: WhatsAppMediaKind.STICKER,
  video: WhatsAppMediaKind.VIDEO,
  audio: WhatsAppMediaKind.AUDIO,
  document: WhatsAppMediaKind.DOCUMENT,
  location: WhatsAppMediaKind.LOCATION,
  contacts: WhatsAppMediaKind.CONTACT,
};

@Injectable()
export class WhatsAppInboundHandlerService {
  private readonly logger = new Logger(WhatsAppInboundHandlerService.name);

  constructor(
    private readonly chatService: WhatsAppChatService,
    private readonly inboundConfig: WhatsAppInboundConfigService,
    private readonly companyConfig: WhatsAppConfigService,
    private readonly contactService: WhatsAppContactService,
    private readonly conversationService: WhatsAppConversationService,
    private readonly optOutService: WhatsAppOptOutService,
    private readonly messageLog: WhatsAppMessageLogService,
    private readonly queueService: WhatsAppQueueService,
    private readonly mediaQueueService: WhatsAppMediaQueueService,
    @InjectRepository(WhatsAppMessageMedia)
    private readonly mediaRepo: Repository<WhatsAppMessageMedia>,
    @Inject(WHATSAPP_CLIENT) private readonly waClient: WhatsAppClientLike | null,
  ) {}

  async handleInboundMessage(metaPhoneNumberId: string, msg: MetaInboundMessage): Promise<void> {
    const companyRow = await this.companyConfig.getByPhoneNumberId(metaPhoneNumberId);
    const routing = await this.inboundConfig.resolve(metaPhoneNumberId);
    const companyId = companyRow?.companyId ?? routing.companyId;

    if (!companyId) {
      this.logger.warn(`No company resolved for phone_number_id ${metaPhoneNumberId}`);
      return;
    }

    const contactPhone = normalizePhoneNumber(msg.from);
    if (!contactPhone) {
      this.logger.warn(`Skipping inbound with invalid from: ${msg.from}`);
      return;
    }

    const body = this.extractBody(msg);

    if (this.optOutService.isOptOutMessage(body)) {
      await this.optOutService.handleOptOut(companyId, contactPhone);
      return;
    }

    const contact = await this.contactService.findOrCreateByPhone(companyId, contactPhone);

    const conversation = await this.conversationService.findOrCreate({
      companyId,
      contactId: contact.id,
      phoneNumber: contactPhone,
      metaPhoneNumberId,
      contactWaId: msg.from,
    });

    const savedMessage = await this.chatService.saveInboundMessage({
      conversationId: conversation.id,
      companyId,
      contactId: contact.id,
      phoneNumber: contactPhone,
      metaWamid: msg.id,
      body: body ?? `[${msg.type}]`,
      messageType: msg.type,
      payload: msg as unknown as Record<string, unknown>,
    });

    await this.conversationService.extendServiceWindow(conversation.id);

    if (routing.markInboundAsRead && this.waClient instanceof MetaWhatsAppClient) {
      await this.queueService.enqueue({
        jobType: WhatsAppJobType.MARK_READ,
        conversationId: conversation.id,
        payload: { metaWamid: msg.id, companyId },
        priority: 10,
        dedupeKey: `mark_read:${msg.id}`,
      });
    }

    const mediaKind = MEDIA_MESSAGE_KIND[msg.type];
    if (mediaKind && savedMessage) {
      const routed = await this.routeMediaMessage(
        mediaKind,
        msg,
        savedMessage.id,
        conversation.id,
        companyId,
        { metaPhoneNumberId, inboundWamid: msg.id, userText: body ?? '' },
      );
      if (routed) {
        this.logger.log(
          `Queued media processing for conversation ${conversation.id} (${msg.type})`,
        );
      }
      // false: media already tracked, or the enqueue failed and a fallback reply was already sent
      // inside routeMediaMessage — either way, nothing further to enqueue here.
      return;
    }

    await this.queueService.enqueue({
      jobType: WhatsAppJobType.INBOUND_REPLY,
      conversationId: conversation.id,
      payload: {
        inboundWamid: msg.id,
        userText: body ?? '',
        metaPhoneNumberId,
        companyId,
      },
      priority: 100,
      dedupeKey: `inbound_reply:${conversation.id}`,
    });

    this.logger.log(`Queued inbound reply for conversation ${conversation.id}`);
  }

  /**
   * Returns true when a media job was queued, false when routing was intentionally skipped
   * (already tracked, or enqueue failed and a fallback INBOUND_REPLY was already sent instead).
   */
  private async routeMediaMessage(
    mediaKind: WhatsAppMediaKind,
    msg: MetaInboundMessage,
    messageId: string,
    conversationId: string,
    companyId: string,
    replyContext: { metaPhoneNumberId: string; inboundWamid: string; userText: string },
  ): Promise<boolean> {
    const existing = await this.mediaRepo.findOne({ where: { messageId } });
    if (existing) {
      // Meta webhook retry for an already-stored message (metaWamid dedupe) — already queued once.
      this.logger.debug(`Media already tracked for message ${messageId}, skipping re-enqueue`);
      return false;
    }

    const metaMediaId = this.extractMetaMediaId(mediaKind, msg);
    const mimeType = this.extractMimeType(mediaKind, msg);
    const structuredData =
      mediaKind === WhatsAppMediaKind.LOCATION
        ? { location: msg.location }
        : mediaKind === WhatsAppMediaKind.CONTACT
          ? {
              contacts: msg.contacts?.map(c => ({
                name: c.name?.formatted_name,
                phones: c.phones?.map(p => p.phone).filter((p): p is string => Boolean(p)),
              })),
            }
          : undefined;

    const mediaRow = await this.mediaRepo.save(
      this.mediaRepo.create({
        messageId,
        conversationId,
        companyId,
        mediaType: mediaKind,
        metaMediaId: metaMediaId ?? null,
        mimeType: mimeType ?? null,
        structuredData: structuredData ?? null,
      }),
    );

    try {
      await this.mediaQueueService.enqueue({
        mediaRowId: mediaRow.id,
        messageId,
        conversationId,
        companyId,
        mediaType: mediaKind,
        metaMediaId,
        mimeType,
        filename: msg.document?.filename,
        caption: msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption,
        isVoiceNote: msg.audio?.voice,
        structuredData,
        ...replyContext,
      });
      return true;
    } catch (err) {
      // Never let a media-queue failure permanently strand the conversation: mark the row failed
      // and fall back to a plain reply, same as if the processor itself had failed downstream.
      const message = (err as Error).message ?? String(err);
      this.logger.error(
        `Failed to enqueue media job for message ${messageId}, falling back to plain reply: ${message}`,
      );
      await this.mediaRepo.update(mediaRow.id, {
        status: WhatsAppMediaProcessingStatus.FAILED,
        errorMessage: message.slice(0, 2000),
        processedAt: new Date(),
      });
      await this.queueService.enqueue({
        jobType: WhatsAppJobType.INBOUND_REPLY,
        conversationId,
        payload: { ...replyContext, companyId },
        priority: 100,
        dedupeKey: `inbound_reply:${conversationId}`,
      });
      return false;
    }
  }

  private extractMetaMediaId(kind: WhatsAppMediaKind, msg: MetaInboundMessage): string | undefined {
    switch (kind) {
      case WhatsAppMediaKind.IMAGE:
        return msg.image?.id;
      case WhatsAppMediaKind.STICKER:
        return msg.sticker?.id;
      case WhatsAppMediaKind.VIDEO:
        return msg.video?.id;
      case WhatsAppMediaKind.AUDIO:
        return msg.audio?.id;
      case WhatsAppMediaKind.DOCUMENT:
        return msg.document?.id;
      default:
        return undefined;
    }
  }

  private extractMimeType(kind: WhatsAppMediaKind, msg: MetaInboundMessage): string | undefined {
    switch (kind) {
      case WhatsAppMediaKind.IMAGE:
        return msg.image?.mime_type;
      case WhatsAppMediaKind.STICKER:
        return msg.sticker?.mime_type;
      case WhatsAppMediaKind.VIDEO:
        return msg.video?.mime_type;
      case WhatsAppMediaKind.AUDIO:
        return msg.audio?.mime_type;
      case WhatsAppMediaKind.DOCUMENT:
        return msg.document?.mime_type;
      default:
        return undefined;
    }
  }

  async handleStatusUpdate(metaPhoneNumberId: string, status: MetaStatusUpdate): Promise<void> {
    const err = status.errors?.[0];
    const details = err?.error_data?.details;
    const errorMeta = {
      code: err?.code != null ? String(err.code) : undefined,
      message: [err?.message ?? err?.title, details].filter(Boolean).join(' — ') || undefined,
    };

    this.logger.log(
      `Meta webhook status wamid=${status.id} status=${status.status} phoneNumberId=${metaPhoneNumberId}` +
        (errorMeta.code ? ` error=${errorMeta.code} ${errorMeta.message ?? ''}` : ''),
    );

    if (status.status === 'failed' && err?.code === 131053) {
      this.logger.warn(
        'Media failed with 131053 — audio/video should use Media API upload (enabled for audio). ' +
          `Details: ${details ?? errorMeta.message ?? 'unsupported format or Meta could not process file'}`,
      );
    }

    const companyRow = await this.companyConfig.getByPhoneNumberId(metaPhoneNumberId);

    if (companyRow?.companyId) {
      const updated = await this.messageLog.updateStatusByWamid(
        companyRow.companyId,
        status.id,
        status.status,
        errorMeta,
      );
      if (updated) {
        await this.syncConversationOnStatus(updated, status.status);
        return;
      }
    }

    const updated = await this.chatService.updateMessageStatusByWamidWithResult(
      status.id,
      status.status,
      errorMeta,
    );

    if (updated) {
      await this.syncConversationOnStatus(updated, status.status);
      return;
    }

    this.logger.warn(
      `Status webhook not matched: wamid=${status.id} status=${status.status} phoneNumberId=${metaPhoneNumberId}. ` +
        'Confirm Meta App → WhatsApp → Configuration subscribes to "messages" field and callback URL is reachable. ' +
        'Delivery updates (delivered/read/failed) only arrive via webhook.',
    );
  }

  private async syncConversationOnStatus(
    msg: { conversationId: string; direction: string },
    status: string,
  ): Promise<void> {
    if (msg.direction === 'outbound') {
      if (status === 'sent' || status === 'delivered' || status === 'read') {
        await this.chatService.touchOutboundActivity(msg.conversationId);
      }
      return;
    }

    if (status === 'read') {
      await this.conversationService.extendServiceWindow(msg.conversationId);
    }
  }

  private extractBody(msg: MetaInboundMessage): string | undefined {
    if (msg.text?.body) {
      return msg.text.body;
    }
    if (msg.image?.caption) {
      return msg.image.caption;
    }
    if (msg.video?.caption) {
      return msg.video.caption;
    }
    if (msg.document?.caption) {
      return msg.document.caption;
    }
    return undefined;
  }
}
