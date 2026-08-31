import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import whatsappConfig from '../../configs/whatsapp.config';
import { WhatsAppConversationStatus } from '../../common/enums/whatsapp.enum';
import { WhatsAppConversation } from '../../models/whatsapp/whatsapp-conversation.entity';
import { normalizePhoneNumber } from '../../common/utils/phone.util';
import {
  isFreeformSessionOpen,
  requiresTemplateForFreeform,
} from '../utils/whatsapp-session-window.util';

@Injectable()
export class WhatsAppConversationService {
  constructor(
    @InjectRepository(WhatsAppConversation)
    private readonly conversationRepo: Repository<WhatsAppConversation>,
    private readonly configService: ConfigService,
  ) {}

  private get freeformWindowMs(): number {
    const hours =
      this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp')
        ?.freeformWindowHours ?? 24;
    return hours * 60 * 60 * 1000;
  }

  isServiceWindowOpen(conversation: WhatsAppConversation): boolean {
    return isFreeformSessionOpen(conversation, Date.now(), this.freeformWindowMs);
  }

  requiresTemplateForFreeform(conversation: WhatsAppConversation): boolean {
    return requiresTemplateForFreeform(conversation, Date.now(), this.freeformWindowMs);
  }

  async extendServiceWindow(conversationId: string): Promise<void> {
    await this.conversationRepo.update(conversationId, {
      serviceWindowExpiresAt: new Date(Date.now() + this.freeformWindowMs),
      lastInboundAt: new Date(),
      lastMessageAt: new Date(),
    });
  }

  assertFreeformAllowed(conversation: WhatsAppConversation): void {
    if (!this.isServiceWindowOpen(conversation)) {
      throw new BadRequestException(
        'Outside 24-hour customer service window. Use an approved WhatsApp template for outbound messages.',
      );
    }
  }

  async findOrCreate(params: {
    companyId: string;
    contactId: string;
    phoneNumber: string;
    metaPhoneNumberId: string;
    contactWaId?: string;
  }): Promise<WhatsAppConversation> {
    const contactPhone = normalizePhoneNumber(params.phoneNumber);
    if (!contactPhone) {
      throw new BadRequestException('Invalid phone number');
    }

    let conv = await this.conversationRepo.findOne({
      where: {
        companyId: params.companyId,
        metaPhoneNumberId: params.metaPhoneNumberId,
        contactPhone,
      },
    });

    if (!conv) {
      conv = await this.conversationRepo.save(
        this.conversationRepo.create({
          companyId: params.companyId,
          contactId: params.contactId,
          contactPhone,
          contactWaId: params.contactWaId ?? null,
          metaPhoneNumberId: params.metaPhoneNumberId,
          status: 'open',
          aiEnabled: true,
        }),
      );
    } else {
      let changed = false;
      if (!conv.contactId) {
        conv.contactId = params.contactId;
        changed = true;
      }
      if (conv.status === WhatsAppConversationStatus.CLOSED) {
        conv.status = WhatsAppConversationStatus.OPEN;
        changed = true;
      }
      if (conv.deletedAt) {
        conv.deletedAt = null;
        changed = true;
      }
      if (changed) {
        await this.conversationRepo.save(conv);
      }
    }

    return conv;
  }

  async getForCompany(
    companyId: string,
    conversationId: string,
  ): Promise<WhatsAppConversation | null> {
    return this.conversationRepo.findOne({
      where: { id: conversationId, companyId, deletedAt: IsNull() },
    });
  }

  async listForCompany(companyId: string, limit = 50, offset = 0): Promise<WhatsAppConversation[]> {
    return this.conversationRepo
      .createQueryBuilder('c')
      .where('c.companyId = :companyId', { companyId })
      .andWhere('c.deletedAt IS NULL')
      .orderBy('COALESCE(c.lastMessageAt, c.updatedAt, c.createdAt)', 'DESC')
      .take(limit)
      .skip(offset)
      .getMany();
  }
}
