import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';

import { MetaWhatsAppApiError } from '../clients/whatsapp/meta-whatsapp.client';
import { mapMetaWhatsAppErrorToHttpException } from './utils/meta-whatsapp-http-error.util';
import { WHATSAPP_CLIENT, type WhatsAppClientLike } from '../clients/whatsapp/whatsapp.provider';
import type { WhatsAppSendResult } from '../clients/whatsapp/whatsapp.types';
import { WhatsAppClient } from '../clients/whatsapp/whatsapp.client';
import { normalizePhoneNumber } from '../common/utils/phone.util';
import whatsappConfig from '../configs/whatsapp.config';
import type { SendWhatsAppMessageDto } from './dto/send-whatsapp-message.dto';
import type { SendWhatsAppTemplateDto } from './dto/send-whatsapp-template.dto';
import type { WhatsAppReplyRoutingInput } from './types/whatsapp-reply-routing.types';
import type {
  MetaInboundMessage,
  MetaStatusUpdate,
} from './services/whatsapp-inbound-handler.service';
import { WhatsAppInboundHandlerService } from './services/whatsapp-inbound-handler.service';
import { WhatsAppOutboundService } from './services/whatsapp-outbound.service';
import {
  WhatsAppTemplateWebhookService,
  type MetaTemplateWebhookValue,
} from './services/whatsapp-template-webhook.service';

function isTwilioLikeError(err: unknown): err is { code?: number; message?: string } {
  return typeof err === 'object' && err !== null && ('code' in err || 'message' in err);
}

function getTwilioWhatsAppErrorMessage(error: { code?: number; message?: string }): string {
  const code = error.code;
  const base =
    typeof error.message === 'string' && error.message
      ? error.message
      : 'Failed to send WhatsApp message';

  switch (code) {
    case 20003:
      return 'WhatsApp: authentication failed. Check Twilio credentials.';
    case 21211:
      return 'WhatsApp: invalid recipient phone number.';
    case 21610:
      return 'WhatsApp: recipient has not opted in.';
    case 63016:
      return 'WhatsApp: outside 24-hour window — use an approved template.';
    default:
      return base;
  }
}

interface MetaWebhookPayload {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        statuses?: MetaStatusUpdate[];
        messages?: MetaInboundMessage[];
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
      };
      field?: string;
    }[];
  }[];
}

const TEMPLATE_WEBHOOK_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'template_category_update',
]);

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @Inject(WHATSAPP_CLIENT) private readonly client: WhatsAppClientLike | null,
    private readonly configService: ConfigService,
    private readonly inboundHandler: WhatsAppInboundHandlerService,
    private readonly outbound: WhatsAppOutboundService,
    private readonly templateWebhook: WhatsAppTemplateWebhookService,
  ) {}

  isConfigured(): boolean {
    return this.client !== null;
  }

  getProvider(): string {
    return (
      this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp')?.provider ?? 'meta'
    );
  }

  private assertReady(): WhatsAppClientLike {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'WhatsApp (Meta) is not configured. Set WHATSAPP_META_ACCESS_TOKEN and WHATSAPP_META_PHONE_NUMBER_ID.',
      );
    }
    return this.client;
  }

  private normalizeTo(raw: string): string {
    const normalized = normalizePhoneNumber(raw);
    if (!normalized) {
      throw new BadRequestException('Invalid recipient phone number');
    }
    return normalized;
  }

  private mapSendError(error: unknown): never {
    this.logger.error(`WhatsApp send failed: ${(error as Error)?.message ?? error}`);
    if (error instanceof MetaWhatsAppApiError) {
      throw mapMetaWhatsAppErrorToHttpException(error);
    }
    if (this.getProvider() === 'twilio' && isTwilioLikeError(error)) {
      throw new BadRequestException(getTwilioWhatsAppErrorMessage(error));
    }
    throw new BadRequestException(
      error instanceof Error ? error.message : 'Failed to send WhatsApp message',
    );
  }

  async healthCheck(): Promise<{ ok: boolean; provider: string }> {
    const provider = this.getProvider();
    if (!this.client) {
      return { ok: false, provider };
    }
    const ok = await this.client.healthCheck();
    return { ok, provider };
  }

  async sendMessage(
    dto: SendWhatsAppMessageDto,
    companyId?: string | null,
  ): Promise<WhatsAppSendResult & { conversationId?: string; messageId?: string }> {
    this.assertReady();

    try {
      return await this.outbound.sendText(
        dto.to,
        dto.body ?? '',
        {
          companyId,
          templateName: dto.templateName,
          templateLanguage: dto.templateLanguage,
          replyRouting: pickReplyRouting(dto),
        },
        dto.mediaUrl,
        dto.mediaType,
      );
    } catch (error: unknown) {
      this.mapSendError(error);
    }
  }

  async sendTemplate(
    dto: SendWhatsAppTemplateDto,
    companyId?: string | null,
  ): Promise<WhatsAppSendResult & { conversationId?: string; messageId?: string }> {
    this.assertReady();

    try {
      return await this.outbound.sendTemplate(dto.to, dto, {
        companyId,
        replyRouting: pickReplyRouting(dto),
      });
    } catch (error: unknown) {
      this.mapSendError(error);
    }
  }

  async sendDesigned(
    design: unknown,
    to: string,
    variables?: Record<string, string>,
    companyId?: string | null,
    replyRouting?: WhatsAppReplyRoutingInput,
  ) {
    this.assertReady();

    try {
      return await this.outbound.sendDesigned(to, design, variables, {
        companyId,
        replyRouting,
      });
    } catch (error: unknown) {
      this.mapSendError(error);
    }
  }

  async getMessageStatus(messageSid: string): Promise<{ messageSid: string; status: string }> {
    const client = this.assertReady();
    if (!messageSid.trim()) {
      throw new BadRequestException('messageSid is required');
    }
    const status = await client.getMessageStatus(messageSid);
    return { messageSid, status };
  }

  verifyMetaWebhook(mode: string | undefined, token: string | undefined): string | null {
    const cfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const verifyToken = cfg?.metaVerifyToken;
    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      return 'ok';
    }
    return null;
  }

  /** Parse Meta webhook and enqueue async processing (fast 200 for Meta). */
  async handleMetaWebhook(payload: MetaWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') {
      this.logger.debug(`Ignoring non-WhatsApp webhook object: ${payload.object ?? 'unknown'}`);
      return;
    }

    const statusCount = (payload.entry ?? []).reduce(
      (n, entry) =>
        n + (entry.changes ?? []).reduce((m, ch) => m + (ch.value?.statuses?.length ?? 0), 0),
      0,
    );
    if (statusCount > 0) {
      this.logger.debug(`Processing Meta webhook with ${statusCount} status update(s)`);
    }

    for (const entry of payload.entry ?? []) {
      const wabaId = entry.id ?? '';
      for (const change of entry.changes ?? []) {
        const field = change.field ?? '';
        const value = change.value;
        if (!value) {
          continue;
        }

        if (TEMPLATE_WEBHOOK_FIELDS.has(field)) {
          await this.templateWebhook.handleTemplateFieldChange(
            wabaId,
            field,
            value as MetaTemplateWebhookValue,
          );
          continue;
        }

        const phoneNumberId = value.metadata?.phone_number_id ?? '';

        for (const status of value.statuses ?? []) {
          await this.inboundHandler.handleStatusUpdate(phoneNumberId, status);
        }

        for (const msg of value.messages ?? []) {
          await this.inboundHandler.handleInboundMessage(phoneNumberId, msg);
        }
      }
    }
  }

  handleTwilioStatusWebhook(payload: Record<string, string>): void {
    const sid = payload.MessageSid ?? payload.SmsSid;
    const status = payload.MessageStatus ?? payload.SmsStatus;
    const errorCode = payload.ErrorCode;
    this.logger.log(
      `Twilio WhatsApp status: sid=${sid ?? 'n/a'} status=${status ?? 'n/a'} error=${errorCode ?? 'none'}`,
    );
  }

  validateTwilioWebhook(
    signature: string | undefined,
    url: string,
    params: Record<string, string>,
  ): boolean {
    if (this.getProvider() !== 'twilio') {
      return true;
    }
    const cfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    if (!cfg?.validateTwilioWebhookSignature) {
      return true;
    }
    if (!(this.client instanceof WhatsAppClient)) {
      return true;
    }
    const authToken = this.configService.get<string>('twilio.authToken');
    if (!authToken || !signature) {
      return false;
    }
    return this.client.validateWebhookSignature(authToken, signature, url, params);
  }
}

function pickReplyRouting(dto: WhatsAppReplyRoutingInput): WhatsAppReplyRoutingInput | undefined {
  if (!dto.routingMode) {
    return undefined;
  }
  return {
    routingMode: dto.routingMode,
    agentId: dto.agentId,
    flowId: dto.flowId,
    scriptId: dto.scriptId,
    aiModel: dto.aiModel,
    aiSystemPrompt: dto.aiSystemPrompt,
  };
}
