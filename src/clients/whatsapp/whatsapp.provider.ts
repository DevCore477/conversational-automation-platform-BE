import { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';

import whatsappConfig, { type WhatsAppProvider } from '../../configs/whatsapp.config';
import { MetaTokenService } from './meta-token.service';
import { MetaWhatsAppClient } from './meta-whatsapp.client';
import { WhatsAppClient } from './whatsapp.client';

export const WHATSAPP_CLIENT = Symbol('WHATSAPP_CLIENT');

export type WhatsAppClientLike = WhatsAppClient | MetaWhatsAppClient;

export const WhatsAppClientProvider: FactoryProvider<WhatsAppClientLike | null> = {
  provide: WHATSAPP_CLIENT,
  inject: [ConfigService, MetaTokenService],
  useFactory: (
    configService: ConfigService,
    metaTokenService: MetaTokenService,
  ): WhatsAppClientLike | null => {
    const cfg = configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    if (!cfg) {
      return null;
    }
    const provider: WhatsAppProvider = cfg.provider;

    if (provider === 'meta') {
      const token = cfg.metaAccessToken;
      const phoneNumberId = cfg.metaPhoneNumberId;
      if (!token || !phoneNumberId) {
        return null;
      }
      return new MetaWhatsAppClient(
        metaTokenService,
        phoneNumberId,
        cfg.metaApiVersion,
        cfg.fromNumber || phoneNumberId,
        cfg.metaDefaultLanguage,
      );
    }

    const accountSid = configService.get<string>('twilio.accountSid');
    const authToken = configService.get<string>('twilio.authToken');
    const fromNumber = cfg.fromNumber;
    if (!accountSid || !authToken || !fromNumber) {
      return null;
    }
    return new WhatsAppClient(accountSid, authToken, fromNumber);
  },
};
