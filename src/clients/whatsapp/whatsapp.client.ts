import Twilio from 'twilio';

import { normalizePhoneNumber } from '../../common/utils/phone.util';
import type {
  SendWhatsAppMediaParams,
  SendWhatsAppTemplateParams,
  SendWhatsAppTextParams,
  WhatsAppSendResult,
} from './whatsapp.types';

function toWhatsAppAddress(e164: string): string {
  const normalized = normalizePhoneNumber(e164);
  if (!normalized) {
    throw new Error('Invalid phone number for WhatsApp');
  }
  return normalized.startsWith('whatsapp:') ? normalized : `whatsapp:${normalized}`;
}

/**
 * Low-level WhatsApp sender via Twilio Messages API.
 * Requires a Twilio number enabled for WhatsApp and recipient opted in (sandbox or approved).
 */
export class WhatsAppClient {
  private readonly client: ReturnType<typeof Twilio>;

  constructor(
    accountSid: string,
    authToken: string,
    private readonly fromNumber: string,
  ) {
    this.client = Twilio(accountSid, authToken);
  }

  private get from(): string {
    return toWhatsAppAddress(this.fromNumber);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const account = await this.client.api.accounts(this.client.accountSid).fetch();
      return !!account.sid;
    } catch {
      return false;
    }
  }

  async sendText(params: SendWhatsAppTextParams): Promise<WhatsAppSendResult> {
    const message = await this.client.messages.create({
      from: this.from,
      to: toWhatsAppAddress(params.to),
      body: params.body,
    });
    return {
      messageSid: message.sid,
      status: message.status,
      to: message.to ?? params.to,
      from: message.from ?? this.fromNumber,
    };
  }

  async sendMedia(params: SendWhatsAppMediaParams): Promise<WhatsAppSendResult> {
    const message = await this.client.messages.create({
      from: this.from,
      to: toWhatsAppAddress(params.to),
      body: params.body,
      mediaUrl: params.mediaUrl,
    });
    return {
      messageSid: message.sid,
      status: message.status,
      to: message.to ?? params.to,
      from: message.from ?? this.fromNumber,
    };
  }

  async sendTemplate(params: SendWhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    const message = await this.client.messages.create({
      from: this.from,
      to: toWhatsAppAddress(params.to),
      contentSid: params.contentSid,
      contentVariables: params.contentVariables
        ? JSON.stringify(params.contentVariables)
        : undefined,
    });
    return {
      messageSid: message.sid,
      status: message.status,
      to: message.to ?? params.to,
      from: message.from ?? this.fromNumber,
    };
  }

  async getMessageStatus(messageSid: string): Promise<string> {
    const message = await this.client.messages(messageSid).fetch();
    return message.status;
  }

  async sendPayload(payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
    const to = String(payload.to ?? '').replace(/^whatsapp:/, '');
    const type = payload.type as string | undefined;

    if (type === 'text' && payload.text && typeof payload.text === 'object') {
      const body = (payload.text as { body?: string }).body ?? '';
      return this.sendText({ to, body });
    }
    if (type === 'template' && payload.template && typeof payload.template === 'object') {
      const tpl = payload.template as {
        name?: string;
        language?: { code?: string };
        components?: { parameters?: { text?: string }[] }[];
      };
      const parameters =
        tpl.components?.[0]?.parameters?.map(p => p.text ?? '').filter(Boolean) ?? [];
      return this.sendTemplate({
        to,
        contentSid: tpl.name ?? '',
        templateName: tpl.name,
        parameters,
        languageCode: tpl.language?.code,
      });
    }
    const mediaTypes = ['image', 'video', 'document', 'audio'] as const;
    for (const mediaType of mediaTypes) {
      if (type === mediaType && payload[mediaType] && typeof payload[mediaType] === 'object') {
        const media = payload[mediaType] as { link?: string; caption?: string };
        if (media.link) {
          return this.sendMedia({
            to,
            body: media.caption,
            mediaUrl: [media.link],
          });
        }
      }
    }
    throw new Error('Twilio WhatsApp does not support this message design type');
  }

  validateWebhookSignature(
    authToken: string,
    signature: string,
    url: string,
    params: Record<string, string>,
  ): boolean {
    return Twilio.validateRequest(authToken, signature, url, params);
  }
}
