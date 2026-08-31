import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { decryptSecret, encryptSecret, maskToken } from '../../common/utils/token-crypto.util';
import whatsappConfig from '../../configs/whatsapp.config';
import { CompanyWhatsAppConfig } from '../../models/whatsapp/company-whatsapp-config.entity';
import { MetaWhatsAppClient } from '../../clients/whatsapp/meta-whatsapp.client';
import { StaticWhatsAppTokenProvider } from '../../clients/whatsapp/whatsapp-token-provider';

/** Lightweight flags for /me and company responses — no token decryption. */
export interface CompanyWhatsAppStatus {
  /** A row exists in `company_whatsapp_configs` for this company. */
  configured: boolean;
  /** Config is active and has phone + token (ready to send). */
  enabled: boolean;
  phoneNumberId: string | null;
  businessPhoneNumber: string | null;
}

export interface CompanyWhatsAppConfigDto {
  id: string;
  companyId: string;
  provider: string;
  wabaId: string | null;
  phoneNumberId: string;
  businessPhoneNumber: string | null;
  accessTokenMasked: string;
  apiVersion: string;
  isActive: boolean;
  maxMessagesPerSecond: number | null;
  maxMessagesPerMinute: number | null;
  maxDailyMessages: number | null;
  qualityStatus: string | null;
  messagingTier: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertCompanyWhatsAppConfigInput {
  wabaId?: string;
  phoneNumberId: string;
  businessPhoneNumber?: string;
  accessToken: string;
  appSecret?: string;
  webhookVerifyToken?: string;
  apiVersion?: string;
  isActive?: boolean;
  maxMessagesPerSecond?: number;
  maxMessagesPerMinute?: number;
  maxDailyMessages?: number;
}

@Injectable()
export class WhatsAppConfigService {
  constructor(
    @InjectRepository(CompanyWhatsAppConfig)
    private readonly configRepo: Repository<CompanyWhatsAppConfig>,
    private readonly configService: ConfigService,
  ) {}

  private get encryptionKey(): string {
    return (
      this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp')?.tokenEncryptionKey ??
      ''
    );
  }

  async getActiveConfigOrThrow(companyId: string): Promise<CompanyWhatsAppConfig> {
    const row = await this.configRepo.findOne({
      where: { companyId, isActive: true },
    });
    if (row) {
      return row;
    }

    const cfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    if (cfg?.allowGlobalMetaFallback && cfg.metaAccessToken && cfg.metaPhoneNumberId) {
      return this.buildFallbackConfig(companyId, cfg);
    }

    throw new ServiceUnavailableException(
      `No active WhatsApp configuration for company ${companyId}. Contact Super Admin.`,
    );
  }

  async getByPhoneNumberId(phoneNumberId: string): Promise<CompanyWhatsAppConfig | null> {
    return this.configRepo.findOne({ where: { phoneNumberId, isActive: true } });
  }

  async getByWabaId(wabaId: string): Promise<CompanyWhatsAppConfig | null> {
    if (!wabaId?.trim()) {
      return null;
    }
    return this.configRepo.findOne({ where: { wabaId: wabaId.trim(), isActive: true } });
  }

  async findAllByWabaId(wabaId: string): Promise<CompanyWhatsAppConfig[]> {
    if (!wabaId?.trim()) {
      return [];
    }
    return this.configRepo.find({ where: { wabaId: wabaId.trim(), isActive: true } });
  }

  /**
   * Fast WhatsApp capability check for company profile / auth — single indexed lookup, no decrypt.
   */
  async getCompanyWhatsAppStatus(companyId: string): Promise<CompanyWhatsAppStatus> {
    const row = await this.configRepo.findOne({
      where: { companyId },
      select: ['id', 'isActive', 'phoneNumberId', 'businessPhoneNumber', 'accessTokenEncrypted'],
    });

    if (row) {
      const hasCredentials =
        row.isActive && Boolean(row.phoneNumberId?.trim()) && Boolean(row.accessTokenEncrypted?.length);
      return {
        configured: true,
        enabled: hasCredentials,
        phoneNumberId: row.phoneNumberId ?? null,
        businessPhoneNumber: row.businessPhoneNumber ?? null,
      };
    }

    const cfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const globalFallback =
      cfg?.allowGlobalMetaFallback === true &&
      Boolean(cfg.metaAccessToken?.trim() && cfg.metaPhoneNumberId?.trim());

    if (globalFallback) {
      return {
        configured: true,
        enabled: true,
        phoneNumberId: cfg!.metaPhoneNumberId!.trim(),
        businessPhoneNumber: cfg!.fromNumber?.trim() ?? null,
      };
    }

    return {
      configured: false,
      enabled: false,
      phoneNumberId: null,
      businessPhoneNumber: null,
    };
  }

  getAccessToken(config: CompanyWhatsAppConfig): string {
    return decryptSecret(config.accessTokenEncrypted, this.encryptionKey);
  }

  getAppSecret(config: CompanyWhatsAppConfig): string | null {
    if (!config.appSecretEncrypted) {
      return null;
    }
    return decryptSecret(config.appSecretEncrypted, this.encryptionKey);
  }

  createMetaClient(config: CompanyWhatsAppConfig): MetaWhatsAppClient {
    const token = this.getAccessToken(config);
    const waCfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    return new MetaWhatsAppClient(
      new StaticWhatsAppTokenProvider(token),
      config.phoneNumberId,
      config.apiVersion ?? waCfg?.metaApiVersion ?? 'v25.0',
      config.businessPhoneNumber ?? config.phoneNumberId,
      waCfg?.metaDefaultLanguage ?? 'en',
    );
  }

  async upsertForCompany(
    companyId: string,
    input: UpsertCompanyWhatsAppConfigInput,
  ): Promise<CompanyWhatsAppConfigDto> {
    if (!input.accessToken?.trim()) {
      throw new BadRequestException('accessToken is required');
    }
    if (!input.phoneNumberId?.trim()) {
      throw new BadRequestException('phoneNumberId is required');
    }

    let row = await this.configRepo.findOne({ where: { companyId } });
    const payload: Partial<CompanyWhatsAppConfig> = {
      companyId,
      provider: 'meta',
      wabaId: input.wabaId ?? null,
      phoneNumberId: input.phoneNumberId.trim(),
      businessPhoneNumber: input.businessPhoneNumber ?? null,
      accessTokenEncrypted: encryptSecret(input.accessToken.trim(), this.encryptionKey),
      appSecretEncrypted: input.appSecret
        ? encryptSecret(input.appSecret.trim(), this.encryptionKey)
        : null,
      webhookVerifyToken: input.webhookVerifyToken ?? null,
      apiVersion: input.apiVersion ?? 'v25.0',
      isActive: input.isActive ?? true,
      maxMessagesPerSecond: input.maxMessagesPerSecond ?? null,
      maxMessagesPerMinute: input.maxMessagesPerMinute ?? null,
      maxDailyMessages: input.maxDailyMessages ?? null,
    };

    if (row) {
      Object.assign(row, payload);
    } else {
      row = this.configRepo.create(payload as CompanyWhatsAppConfig);
    }

    const saved = await this.configRepo.save(row);
    return this.toDto(saved);
  }

  async getForCompany(companyId: string): Promise<CompanyWhatsAppConfigDto> {
    const row = await this.configRepo.findOne({ where: { companyId } });
    if (!row) {
      throw new NotFoundException('WhatsApp config not found for company');
    }
    return this.toDto(row);
  }

  async updateWabaId(companyId: string, wabaId: string): Promise<CompanyWhatsAppConfig> {
    const row = await this.configRepo.findOne({ where: { companyId } });
    if (!row) {
      throw new NotFoundException('WhatsApp config not found');
    }
    row.wabaId = wabaId;
    return this.configRepo.save(row);
  }

  async setActive(companyId: string, isActive: boolean): Promise<CompanyWhatsAppConfigDto> {
    const row = await this.configRepo.findOne({ where: { companyId } });
    if (!row) {
      throw new NotFoundException('WhatsApp config not found');
    }
    row.isActive = isActive;
    return this.toDto(await this.configRepo.save(row));
  }

  toDto(row: CompanyWhatsAppConfig): CompanyWhatsAppConfigDto {
    const token = decryptSecret(row.accessTokenEncrypted, this.encryptionKey);
    return {
      id: row.id,
      companyId: row.companyId,
      provider: row.provider,
      wabaId: row.wabaId,
      phoneNumberId: row.phoneNumberId,
      businessPhoneNumber: row.businessPhoneNumber,
      accessTokenMasked: maskToken(token),
      apiVersion: row.apiVersion,
      isActive: row.isActive,
      maxMessagesPerSecond: row.maxMessagesPerSecond,
      maxMessagesPerMinute: row.maxMessagesPerMinute,
      maxDailyMessages: row.maxDailyMessages,
      qualityStatus: row.qualityStatus,
      messagingTier: row.messagingTier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private buildFallbackConfig(
    companyId: string,
    cfg: ConfigType<typeof whatsappConfig>,
  ): CompanyWhatsAppConfig {
    return {
      id: 'fallback',
      companyId,
      provider: 'meta',
      wabaId: null,
      phoneNumberId: cfg.metaPhoneNumberId,
      businessPhoneNumber: cfg.fromNumber || null,
      accessTokenEncrypted: encryptSecret(cfg.metaAccessToken, this.encryptionKey),
      appSecretEncrypted: cfg.metaAppSecret
        ? encryptSecret(cfg.metaAppSecret, this.encryptionKey)
        : null,
      webhookVerifyToken: cfg.metaVerifyToken || null,
      apiVersion: cfg.metaApiVersion,
      isActive: true,
      maxMessagesPerSecond: cfg.maxMessagesPerSecond,
      maxMessagesPerMinute: cfg.maxMessagesPerMinute,
      maxDailyMessages: null,
      qualityStatus: null,
      messagingTier: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
}
