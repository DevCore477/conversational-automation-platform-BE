import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';

import {
  extractPhoneNumberIdsFromWebhook,
  extractStatusEventsFromWebhook,
} from '../../clients/whatsapp/meta-webhook-payload.util';
import { validateMetaWebhookSignature } from '../../clients/whatsapp/meta-webhook.util';
import whatsappConfig from '../../configs/whatsapp.config';
import { WhatsAppConfigService } from './whatsapp-config.service';

@Injectable()
export class WhatsAppMetaWebhookVerifyService {
  private readonly logger = new Logger(WhatsAppMetaWebhookVerifyService.name);

  constructor(
    private readonly nestConfig: ConfigService,
    private readonly companyConfig: WhatsAppConfigService,
  ) {}

  async validateSignature(
    signature: string | undefined,
    rawBody: string | Buffer,
    body: Record<string, unknown>,
  ): Promise<boolean> {
    const cfg = this.nestConfig.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    if (cfg?.metaSkipWebhookSignature) {
      return true;
    }

    const secrets = await this.collectAppSecrets(body, cfg?.metaAppSecret);
    if (secrets.length === 0) {
      this.logger.warn(
        'Meta webhook: no app secret configured (WHATSAPP_META_APP_SECRET or company appSecret). ' +
          'Signature verification skipped — set secrets in production.',
      );
      return true;
    }

    for (const secret of secrets) {
      if (validateMetaWebhookSignature(secret, signature, rawBody)) {
        return true;
      }
    }

    const phoneIds = extractPhoneNumberIdsFromWebhook(body);
    const statusCount = extractStatusEventsFromWebhook(body).length;
    this.logger.warn(
      `Meta webhook signature invalid. phoneNumberIds=[${phoneIds.join(',')}] statusEvents=${statusCount}. ` +
        'Use the App Secret from the same Meta app as the access token (or company appSecret).',
    );
    return false;
  }

  private async collectAppSecrets(
    body: Record<string, unknown>,
    globalSecret?: string,
  ): Promise<string[]> {
    const secrets = new Set<string>();
    if (globalSecret?.trim()) {
      secrets.add(globalSecret.trim());
    }

    for (const phoneNumberId of extractPhoneNumberIdsFromWebhook(body)) {
      const row = await this.companyConfig.getByPhoneNumberId(phoneNumberId);
      if (!row) {
        continue;
      }
      const secret = this.companyConfig.getAppSecret(row);
      if (secret) {
        secrets.add(secret);
      }
    }

    return [...secrets];
  }
}
