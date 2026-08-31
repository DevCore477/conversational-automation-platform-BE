import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';

import { MetaWhatsAppApiError } from '../../clients/whatsapp/meta-whatsapp.client';
import {
  isMetaWhatsAppAuthError,
  mapMetaWhatsAppErrorToHttpException,
} from '../utils/meta-whatsapp-http-error.util';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';

import whatsappConfig from '../../configs/whatsapp.config';
import { CompanyWhatsAppConfig } from '../../models/whatsapp/company-whatsapp-config.entity';
import { WhatsAppConfigService } from './whatsapp-config.service';

export interface MetaMessageTemplateRow {
  id: string;
  name: string;
  status: string;
  category?: string;
  language: string;
  components?: Record<string, unknown>[];
}

interface MetaTemplateListResponse {
  data?: MetaMessageTemplateRow[];
  paging?: { next?: string };
  error?: { message?: string; code?: number };
}

interface MetaGraphError {
  message?: string;
  code?: number;
  type?: string;
}

interface MetaListResponse<T> {
  data?: T[];
  paging?: { next?: string };
  error?: MetaGraphError;
}

@Injectable()
export class MetaTemplateApiService {
  private readonly logger = new Logger(MetaTemplateApiService.name);

  constructor(
    private readonly configService: WhatsAppConfigService,
    private readonly nestConfig: ConfigService,
  ) {}

  async listAllTemplates(config: CompanyWhatsAppConfig): Promise<MetaMessageTemplateRow[]> {
    const wabaId = await this.resolveWabaId(config);
    const token = this.configService.getAccessToken(config);
    const version = config.apiVersion ?? 'v25.0';

    const all: MetaMessageTemplateRow[] = [];
    let url: string | null = this.templateListUrl(version, wabaId);

    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as MetaTemplateListResponse;

      if (!res.ok || json.error) {
        if (json.error?.code === 100 && config.wabaId?.trim()) {
          this.logger.warn(
            `message_templates failed on configured wabaId=${config.wabaId}; retrying WABA resolution`,
          );
          const resolved = await this.resolveWabaId({ ...config, wabaId: null });
          if (resolved && resolved !== wabaId) {
            return this.listAllTemplates({ ...config, wabaId: resolved });
          }
        }
        throw metaTemplateListHttpException(json.error, res.status, wabaId, config);
      }

      all.push(...(json.data ?? []));
      url = json.paging?.next ?? null;
    }

    this.logger.log(`Fetched ${all.length} templates from Meta WABA ${wabaId}`);
    return all;
  }

  /**
   * WABA id is required for /message_templates — NOT phoneNumberId.
   */
  async resolveWabaId(config: CompanyWhatsAppConfig): Promise<string> {
    const phoneId = config.phoneNumberId?.trim();
    const configured = config.wabaId?.trim();

    if (configured && configured === phoneId) {
      this.logger.warn(
        'company wabaId equals phoneNumberId — ignoring wabaId and resolving real WABA',
      );
    }

    const effectiveConfigured =
      configured && configured !== phoneId ? configured : null;

    if (effectiveConfigured) {
      const configuredIsWaba = await this.nodeHasMessageTemplatesEdge(
        effectiveConfigured,
        config,
      );
      if (configuredIsWaba) {
        return effectiveConfigured;
      }
      this.logger.warn(
        `Configured wabaId=${effectiveConfigured} cannot access message_templates; scanning accessible WABAs`,
      );
    }

    const fromScan = await this.findWabaIdByPhoneNumberScan(config);
    if (fromScan) {
      return fromScan;
    }

    const fromScopes = await this.findWabaIdFromTokenScopes(config);
    if (fromScopes) {
      return fromScopes;
    }

    const fromLegacyPhoneField = await this.fetchWabaIdFromPhoneNumberLegacyField(config);
    if (fromLegacyPhoneField) {
      return fromLegacyPhoneField;
    }

    if (effectiveConfigured) {
      throw new BadRequestException(
        `Invalid wabaId "${effectiveConfigured}": Meta cannot list message_templates on this id. ` +
          `phoneNumberId=${phoneId}. ` +
          'Set the correct WhatsApp Business Account id from Meta Business Suite → WhatsApp accounts, ' +
          'or ensure the access token has whatsapp_business_management on that WABA.',
      );
    }

    throw new BadRequestException(
      'Could not resolve WhatsApp Business Account id from your access token and phoneNumberId. ' +
        'Add wabaId to company WhatsApp config (Meta Business Suite → WhatsApp accounts), ' +
        'and ensure the token has whatsapp_business_management permission.',
    );
  }

  private templateListUrl(version: string, wabaId: string): string {
    return `https://graph.facebook.com/${version}/${wabaId}/message_templates?limit=100`;
  }

  private async nodeHasMessageTemplatesEdge(
    nodeId: string,
    config: CompanyWhatsAppConfig,
  ): Promise<boolean> {
    const token = this.configService.getAccessToken(config);
    const version = config.apiVersion ?? 'v25.0';
    const url = this.templateListUrl(version, nodeId).replace('limit=100', 'limit=1');

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as MetaTemplateListResponse;
    return res.ok && !json.error;
  }

  /** Scan businesses → owned WABAs → phone_numbers to find WABA for phoneNumberId. */
  private async findWabaIdByPhoneNumberScan(
    config: CompanyWhatsAppConfig,
  ): Promise<string | null> {
    const phoneId = config.phoneNumberId?.trim();
    if (!phoneId) {
      return null;
    }

    const token = this.configService.getAccessToken(config);
    const version = config.apiVersion ?? 'v25.0';

    const businessIds = await this.fetchAccessibleBusinessIds(token, version);
    const wabaIds = new Set<string>();

    for (const businessId of businessIds) {
      const owned = await this.fetchGraphList<{ id: string }>(
        token,
        `https://graph.facebook.com/${version}/${businessId}/owned_whatsapp_business_accounts?fields=id&limit=100`,
      );
      for (const row of owned) {
        if (row.id) {
          wabaIds.add(row.id);
        }
      }

      const client = await this.fetchGraphList<{ id: string }>(
        token,
        `https://graph.facebook.com/${version}/${businessId}/client_whatsapp_business_accounts?fields=id&limit=100`,
      );
      for (const row of client) {
        if (row.id) {
          wabaIds.add(row.id);
        }
      }
    }

    for (const wabaId of wabaIds) {
      const phones = await this.fetchGraphList<{ id: string }>(
        token,
        `https://graph.facebook.com/${version}/${wabaId}/phone_numbers?fields=id&limit=100`,
      );
      if (phones.some(p => p.id === phoneId)) {
        this.logger.log(
          `Resolved WABA id ${wabaId} by scanning phone_numbers for phoneNumberId ${phoneId}`,
        );
        return wabaId;
      }
    }

    return null;
  }

  private async fetchAccessibleBusinessIds(
    token: string,
    version: string,
  ): Promise<string[]> {
    const ids = new Set<string>();

    const meBusinesses = await this.fetchGraphList<{ id: string }>(
      token,
      `https://graph.facebook.com/${version}/me/businesses?fields=id&limit=100`,
    );
    for (const b of meBusinesses) {
      if (b.id) {
        ids.add(b.id);
      }
    }

    const nested = await this.graphGet<{ businesses?: { data?: { id: string }[] } }>(
      token,
      `https://graph.facebook.com/${version}/me?fields=businesses{id}`,
    );
    for (const b of nested?.businesses?.data ?? []) {
      if (b.id) {
        ids.add(b.id);
      }
    }

    return [...ids];
  }

  /** Extract WABA ids from debug_token granular_scopes and match phone number. */
  private async findWabaIdFromTokenScopes(
    config: CompanyWhatsAppConfig,
  ): Promise<string | null> {
    const wa = this.nestConfig.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const appId = wa?.metaAppId?.trim();
    const appSecret = wa?.metaAppSecret?.trim();
    if (!appId || !appSecret) {
      return null;
    }

    const token = this.configService.getAccessToken(config);
    const version = config.apiVersion ?? 'v25.0';
    const phoneId = config.phoneNumberId?.trim();
    if (!phoneId) {
      return null;
    }

    const debug = await this.graphGet<{
      data?: {
        granular_scopes?: { scope?: string; target_ids?: string[] }[];
      };
    }>(
      `${appId}|${appSecret}`,
      `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(token)}`,
    );

    const scopeNames = new Set([
      'whatsapp_business_management',
      'whatsapp_business_messaging',
      'business_management',
    ]);

    const candidateWabas = new Set<string>();
    for (const gs of debug?.data?.granular_scopes ?? []) {
      if (!gs.scope || !scopeNames.has(gs.scope)) {
        continue;
      }
      for (const id of gs.target_ids ?? []) {
        candidateWabas.add(id);
      }
    }

    for (const wabaId of candidateWabas) {
      const phones = await this.fetchGraphList<{ id: string }>(
        token,
        `https://graph.facebook.com/${version}/${wabaId}/phone_numbers?fields=id&limit=100`,
      );
      if (phones.some(p => p.id === phoneId)) {
        this.logger.log(`Resolved WABA id ${wabaId} from token granular_scopes`);
        return wabaId;
      }

      if (await this.nodeHasMessageTemplatesEdge(wabaId, config)) {
        const singlePhone = await this.fetchGraphList<{ id: string }>(
          token,
          `https://graph.facebook.com/${version}/${wabaId}/phone_numbers?fields=id&limit=5`,
        );
        if (singlePhone.length === 1 && singlePhone[0]?.id === phoneId) {
          return wabaId;
        }
        if (singlePhone.length === 0 && candidateWabas.size === 1) {
          return wabaId;
        }
      }
    }

    return null;
  }

  /** Legacy Graph field — removed on many API versions; kept as last resort. */
  private async fetchWabaIdFromPhoneNumberLegacyField(
    config: CompanyWhatsAppConfig,
  ): Promise<string | null> {
    if (!config.phoneNumberId?.trim()) {
      return null;
    }

    const token = this.configService.getAccessToken(config);
    const version = config.apiVersion ?? 'v25.0';
    const phoneId = config.phoneNumberId.trim();

    const url = new URL(`https://graph.facebook.com/${version}/${phoneId}`);
    url.searchParams.set('fields', 'whatsapp_business_account{id}');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as {
      whatsapp_business_account?: { id?: string };
      error?: MetaGraphError;
    };

    if (!res.ok || json.error) {
      this.logger.debug(
        `Legacy WABA field on phoneNumberId unavailable: ${json.error?.message ?? res.status}`,
      );
      return null;
    }

    const id = json.whatsapp_business_account?.id;
    if (id) {
      this.logger.log(`Resolved WABA id ${id} via legacy whatsapp_business_account field`);
      return id;
    }
    return null;
  }

  private async fetchGraphList<T>(token: string, initialUrl: string): Promise<T[]> {
    const all: T[] = [];
    let url: string | null = initialUrl;

    while (url) {
      const json = await this.graphGet<MetaListResponse<T>>(token, url);
      if (!json) {
        break;
      }
      all.push(...(json.data ?? []));
      url = json.paging?.next ?? null;
    }

    return all;
  }

  private async graphGet<T>(token: string, url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as T & { error?: MetaGraphError };
      if (!res.ok || json.error) {
        return null;
      }
      return json;
    } catch {
      return null;
    }
  }
}

function formatMetaError(
  error: MetaGraphError | undefined,
  wabaId: string,
  config: CompanyWhatsAppConfig,
): string {
  const base = error?.message ?? 'Meta template list failed';
  if (error?.code === 100) {
    return (
      `${base}. The id "${wabaId}" is not a WhatsApp Business Account. ` +
      `phoneNumberId=${config.phoneNumberId}. ` +
      'Set wabaId to your WABA id from Meta Business Suite → WhatsApp accounts (not the phone number id). ' +
      'Or remove wabaId and sync again — we resolve WABA from your token automatically.'
    );
  }
  if (error?.code === 200 || error?.type === 'OAuthException') {
    return `${base}. Ensure the access token has whatsapp_business_management permission.`;
  }
  return base;
}

function metaTemplateListHttpException(
  error: MetaGraphError | undefined,
  httpStatus: number,
  wabaId: string,
  config: CompanyWhatsAppConfig,
): HttpException {
  const metaError = new MetaWhatsAppApiError(
    error?.message ?? 'Meta template list failed',
    error?.code,
    error?.type,
    httpStatus,
  );
  if (isMetaWhatsAppAuthError(metaError)) {
    return mapMetaWhatsAppErrorToHttpException(metaError);
  }
  return new BadRequestException(formatMetaError(error, wabaId, config));
}
