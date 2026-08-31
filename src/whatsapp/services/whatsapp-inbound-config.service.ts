import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WhatsAppRoutingMode } from '../../common/enums/whatsapp.enum';
import { WhatsAppInboundConfig } from '../../models/whatsapp/whatsapp-inbound-config.entity';

export interface ResolvedWhatsAppRouting {
  config: WhatsAppInboundConfig;
  routingMode: WhatsAppRoutingMode;
  agentId: string | null;
  flowId: string | null;
  scriptId: string | null;
  aiModel: string;
  aiSystemPrompt: string | null;
  sendGreetingOnFirstMessage: boolean;
  markInboundAsRead: boolean;
  companyId: string | null;
}

@Injectable()
export class WhatsAppInboundConfigService {
  constructor(
    @InjectRepository(WhatsAppInboundConfig)
    private readonly configRepo: Repository<WhatsAppInboundConfig>,
    private readonly appConfig: ConfigService,
  ) {}

  async findByPhoneNumberId(metaPhoneNumberId: string): Promise<WhatsAppInboundConfig | null> {
    return this.configRepo.findOne({ where: { metaPhoneNumberId } });
  }

  async resolve(metaPhoneNumberId: string): Promise<ResolvedWhatsAppRouting> {
    const row =
      (await this.findByPhoneNumberId(metaPhoneNumberId)) ??
      (await this.createDefaultFromEnv(metaPhoneNumberId));

    return {
      config: row,
      routingMode: row.routingMode as WhatsAppRoutingMode,
      agentId: row.agentId,
      flowId: row.flowId,
      scriptId: row.scriptId,
      aiModel: row.aiModel,
      aiSystemPrompt: row.aiSystemPrompt,
      sendGreetingOnFirstMessage: row.sendGreetingOnFirstMessage,
      markInboundAsRead: row.markInboundAsRead,
      companyId: row.companyId,
    };
  }

  private async createDefaultFromEnv(metaPhoneNumberId: string): Promise<WhatsAppInboundConfig> {
    const cfg = this.appConfig.get('whatsapp');
    const envPhoneId = cfg?.metaPhoneNumberId;
    const prompt =
      this.appConfig.get<string>('app.inboundCallScript') ??
      'You are a helpful AI assistant replying on WhatsApp. Be concise and professional.';

    const row = this.configRepo.create({
      metaPhoneNumberId,
      companyId: this.appConfig.get<string>('app.platformCompanyId') || null,
      routingMode: WhatsAppRoutingMode.AI,
      aiModel: 'gpt-4o-mini',
      aiSystemPrompt: prompt,
      sendGreetingOnFirstMessage: true,
      markInboundAsRead: true,
    });

    if (envPhoneId === metaPhoneNumberId) {
      return this.configRepo.save(row);
    }

    return row;
  }

  async upsert(dto: Partial<WhatsAppInboundConfig> & { metaPhoneNumberId: string }) {
    let row = await this.findByPhoneNumberId(dto.metaPhoneNumberId);
    if (!row) {
      row = this.configRepo.create(dto);
    } else {
      Object.assign(row, dto);
    }
    return this.configRepo.save(row);
  }

  async getOne(id: string): Promise<WhatsAppInboundConfig> {
    const row = await this.configRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('WhatsApp inbound config not found');
    }
    return row;
  }
}
