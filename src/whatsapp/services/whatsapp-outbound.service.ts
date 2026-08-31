import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';

import { MetaWhatsAppApiError } from '../../clients/whatsapp/meta-whatsapp.client';
import { WHATSAPP_CLIENT, type WhatsAppClientLike } from '../../clients/whatsapp/whatsapp.provider';
import type {
  SendWhatsAppTemplateParams,
  WhatsAppMediaType,
  WhatsAppSendResult,
} from '../../clients/whatsapp/whatsapp.types';
import { WhatsAppMessageDirection, WhatsAppMessageStatus } from '../../common/enums/whatsapp.enum';
import { normalizePhoneNumber } from '../../common/utils/phone.util';
import whatsappConfig from '../../configs/whatsapp.config';
import {
  resolveDesignOutboundStorage,
  buildTemplateOutboundStorage,
} from '../utils/whatsapp-outbound-storage.util';
import { WhatsAppMessageBuilderService } from '../whatsapp-message-builder.service';
import { WhatsAppChatService } from './whatsapp-chat.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import { WhatsAppContactService } from './whatsapp-contact.service';
import { WhatsAppConversation } from '../../models/whatsapp/whatsapp-conversation.entity';
import { WhatsAppConversationService } from './whatsapp-conversation.service';
import { WhatsAppInboundConfigService } from './whatsapp-inbound-config.service';
import { WhatsAppTemplateService } from './whatsapp-template.service';
import { toMetaLanguageCode } from './whatsapp-template.mapper';
import type { SendWhatsAppTemplateParams as TemplateSendDtoParams } from '../dto/send-whatsapp-template.dto';
import type { WhatsAppReplyRoutingInput } from '../types/whatsapp-reply-routing.types';
import { rethrowWhatsAppProviderError } from '../utils/meta-whatsapp-http-error.util';
import { toReplyRoutingConfig } from '../utils/whatsapp-reply-routing.util';
import {
  buildTemplateSendComponents,
  TemplateVariableError,
} from '../utils/whatsapp-template-send.util';

export interface SendOutboundContext {
  companyId?: string | null;
  /** Override default template used outside the 24h session window. */
  templateName?: string;
  templateLanguage?: string;
  /** Omitting this resets any previously-pinned routing on the conversation — see `applyReplyRoutingIfConfigured`. */
  replyRouting?: WhatsAppReplyRoutingInput;
}

interface SendingContext {
  companyId: string | null;
  client: WhatsAppClientLike;
  metaPhoneNumberId: string;
}

@Injectable()
export class WhatsAppOutboundService {
  private readonly logger = new Logger(WhatsAppOutboundService.name);

  constructor(
    @Inject(WHATSAPP_CLIENT) private readonly client: WhatsAppClientLike | null,
    private readonly nestConfig: ConfigService,
    private readonly chatService: WhatsAppChatService,
    private readonly conversationService: WhatsAppConversationService,
    private readonly contactService: WhatsAppContactService,
    private readonly companyConfig: WhatsAppConfigService,
    private readonly inboundConfig: WhatsAppInboundConfigService,
    private readonly messageBuilder: WhatsAppMessageBuilderService,
    private readonly templateService: WhatsAppTemplateService,
  ) {}

  async sendText(
    to: string,
    body: string,
    ctx: SendOutboundContext = {},
    mediaUrl?: string[],
    mediaType?: WhatsAppMediaType,
  ): Promise<WhatsAppSendResult & { conversationId: string; messageId: string }> {
    const phone = this.normalizePhone(to);
    const sending = await this.resolveSendingContext(ctx);
    const { conversation, companyId, contactId } = await this.prepareConversation(phone, sending);
    await this.applyReplyRoutingIfConfigured(conversation.id, ctx);

    const hasMedia = Boolean(mediaUrl?.length);
    const caption = body?.trim() ?? '';

    if (this.conversationService.requiresTemplateForFreeform(conversation)) {
      if (hasMedia) {
        throw new BadRequestException(
          'Outside the 24-hour customer service window. Media cannot be sent until the customer messages you, or use POST /whatsapp/templates with an approved template that includes media.',
        );
      }
      const templateFallback = this.resolveOutboundTemplateFallback(ctx);
      if (!templateFallback) {
        throw new BadRequestException(OUTSIDE_WINDOW_NO_TEMPLATE_MESSAGE);
      }
      this.logger.log(
        `Outside 24h window for ${phone} — sending template "${templateFallback.templateName}" instead of free-form text`,
      );
      return this.sendTemplate(
        phone,
        {
          templateName: templateFallback.templateName,
          parameters: caption ? [caption] : undefined,
          languageCode: templateFallback.languageCode,
        },
        ctx,
      );
    }

    const pending = await this.chatService.createOutboundPending({
      conversationId: conversation.id,
      body: hasMedia ? caption || `[media:${mediaUrl![0]}]` : caption,
      messageType: hasMedia ? 'media' : 'text',
      companyId,
      contactId,
      phoneNumber: phone,
      mediaUrl: hasMedia ? mediaUrl?.[0] : null,
    });

    try {
      const result = hasMedia
        ? await sending.client.sendMedia({
            to: phone,
            body: caption || undefined,
            mediaUrl: mediaUrl!,
            mediaType,
          })
        : await sending.client.sendText({ to: phone, body: caption });

      await this.finalizeOutbound(pending.id, conversation.id, result.messageSid);
      return { ...result, conversationId: conversation.id, messageId: pending.id };
    } catch (error: unknown) {
      await this.chatService.markOutboundFailed(
        pending.id,
        extractErrorCode(error),
        extractErrorMessage(error),
      );
      rethrowWhatsAppProviderError(error);
    }
  }

  async sendTemplate(
    to: string,
    params: TemplateSendDtoParams,
    ctx: SendOutboundContext = {},
  ): Promise<
    WhatsAppSendResult & {
      conversationId: string;
      messageId: string;
      templateId?: string;
      templateName: string;
      preview?: string;
    }
  > {
    const phone = this.normalizePhone(to);
    const sending = await this.resolveSendingContext(ctx);
    const { conversation, companyId, contactId } = await this.prepareConversation(phone, sending);
    await this.applyReplyRoutingIfConfigured(conversation.id, ctx);

    const resolved = await this.resolveTemplateForSend(params, companyId);

    let components;
    try {
      components = buildTemplateSendComponents({
        components: params.components,
        headerParameters: params.headerParameters,
        bodyParameters: params.bodyParameters,
        parameters: params.parameters,
        contentVariables: params.contentVariables,
        buttonParameters: params.buttonParameters,
        templateComponents: resolved.components,
        bodyPreview: resolved.bodyPreview,
      });
    } catch (error: unknown) {
      if (error instanceof TemplateVariableError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const sendVars = {
      parameters: params.parameters ?? params.bodyParameters,
      contentVariables: params.contentVariables,
    };
    const storage = buildTemplateOutboundStorage({
      templateName: resolved.templateName,
      templateId: resolved.templateId,
      bodyPreview: resolved.bodyPreview,
      sendVars,
    });

    const pending = await this.chatService.createOutboundPending({
      conversationId: conversation.id,
      body: storage.body,
      messageType: 'template',
      companyId,
      contactId,
      phoneNumber: phone,
      templateName: storage.templateName,
      payload: storage.payload,
    });

    try {
      const result = await sending.client.sendTemplate({
        to: phone,
        contentSid: resolved.templateName,
        templateName: resolved.templateName,
        languageCode: resolved.languageCode,
        components: components as SendWhatsAppTemplateParams['components'],
      });

      await this.finalizeOutbound(pending.id, conversation.id, result.messageSid);
      return {
        ...result,
        conversationId: conversation.id,
        messageId: pending.id,
        templateId: resolved.templateId,
        templateName: resolved.templateName,
        preview: storage.body,
      };
    } catch (error: unknown) {
      await this.chatService.markOutboundFailed(
        pending.id,
        extractErrorCode(error),
        extractErrorMessage(error),
      );
      rethrowWhatsAppProviderError(error);
    }
  }

  private async resolveTemplateForSend(
    params: TemplateSendDtoParams,
    companyId: string | null,
  ): Promise<{
    templateId?: string;
    templateName: string;
    languageCode: string;
    bodyPreview?: string | null;
    components?: Record<string, unknown>[] | null;
  }> {
    if (params.templateId) {
      if (!companyId) {
        throw new BadRequestException('templateId requires an authenticated company context');
      }
      const template = await this.templateService.getApprovedEntity(companyId, params.templateId);
      return {
        templateId: template.id,
        templateName: template.metaTemplateName,
        languageCode: params.languageCode
          ? toMetaLanguageCode(params.languageCode)
          : toMetaLanguageCode(template.language),
        bodyPreview: template.bodyPreview,
        components: template.components,
      };
    }

    const templateName = params.templateName?.trim();
    if (!templateName) {
      throw new BadRequestException('templateName is required when templateId is omitted');
    }

    let bodyPreview: string | null | undefined;
    let components: Record<string, unknown>[] | null | undefined;
    let approvedLanguage: string | undefined;
    if (companyId) {
      // Match the specific language variant when the caller specified one, so bodyPreview/
      // components reflect that variant rather than whichever language row updated most recently.
      const row = await this.templateService.findByMetaName(companyId, templateName, params.languageCode);
      bodyPreview = row?.bodyPreview;
      components = row?.components;
      approvedLanguage = row?.language;
    }

    const cfg = this.nestConfig.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    return {
      templateName,
      // Prefer the template's own approved language (from the synced DB row) over the global
      // default — sending the wrong language code fails with Meta error 132001 ("Template name
      // does not exist in the translation") even when the template name itself is correct.
      languageCode: params.languageCode
        ? toMetaLanguageCode(params.languageCode)
        : toMetaLanguageCode(approvedLanguage ?? cfg?.metaDefaultLanguage ?? 'en'),
      bodyPreview,
      components,
    };
  }

  async sendDesigned(
    to: string,
    designInput: unknown,
    variables?: Record<string, string>,
    ctx: SendOutboundContext = {},
  ): Promise<WhatsAppSendResult & { preview: string; conversationId: string; messageId: string }> {
    const phone = this.normalizePhone(to);
    const sending = await this.resolveSendingContext(ctx);
    const { conversation, companyId } = await this.prepareConversation(phone, sending);
    await this.applyReplyRoutingIfConfigured(conversation.id, ctx);

    const design = this.messageBuilder.parseDesign(designInput);
    let templateMeta: { templateId?: string; bodyPreview?: string | null } | null = null;
    if (design.type === 'template' && companyId) {
      const row = await this.templateService.findByMetaName(companyId, design.templateName);
      if (row) {
        templateMeta = { templateId: row.id, bodyPreview: row.bodyPreview };
      }
    }
    const storage = resolveDesignOutboundStorage(design, variables, templateMeta);

    const pending = await this.chatService.createOutboundPending({
      conversationId: conversation.id,
      body: storage.body,
      messageType: design.type,
      companyId,
      phoneNumber: phone,
      templateName: storage.templateName,
      payload: storage.payload,
    });

    try {
      const result = await this.messageBuilder.sendDesigned(
        designInput,
        phone,
        variables,
        sending.client,
      );
      await this.finalizeOutbound(pending.id, conversation.id, result.messageSid);

      return {
        ...result,
        conversationId: conversation.id,
        messageId: pending.id,
      };
    } catch (error: unknown) {
      await this.chatService.markOutboundFailed(
        pending.id,
        extractErrorCode(error),
        extractErrorMessage(error),
      );
      rethrowWhatsAppProviderError(error);
    }
  }

  async retryMessage(
    companyId: string,
    conversationId: string,
    messageId: string,
  ): Promise<WhatsAppSendResult & { conversationId: string; messageId: string }> {
    const msg = await this.chatService.getMessageForCompany(companyId, messageId);
    if (msg?.conversationId !== conversationId) {
      throw new NotFoundException('Message not found');
    }
    if (msg.direction !== WhatsAppMessageDirection.OUTBOUND) {
      throw new BadRequestException('Only outbound messages can be retried');
    }
    if (
      msg.status !== WhatsAppMessageStatus.FAILED &&
      msg.status !== WhatsAppMessageStatus.PENDING
    ) {
      throw new BadRequestException(
        `Message cannot be retried in status "${msg.status}". Only failed or pending messages are retryable.`,
      );
    }

    const phone = msg.phoneNumber;
    if (!phone) {
      throw new BadRequestException('Message has no recipient phone number');
    }

    const sending = await this.resolveSendingContext({ companyId });
    await this.chatService.resetMessageForRetry(messageId);

    try {
      let result: WhatsAppSendResult;
      if (msg.messageType === 'template' && msg.templateName) {
        result = await sending.client.sendTemplate({
          to: phone,
          contentSid: msg.templateName,
          templateName: msg.templateName,
        });
      } else if (msg.messageType === 'media' && msg.mediaUrl) {
        result = await sending.client.sendMedia({
          to: phone,
          body: msg.body ?? undefined,
          mediaUrl: [msg.mediaUrl],
        });
      } else {
        const body = msg.body?.trim();
        if (!body) {
          throw new BadRequestException('Message has no text body to resend');
        }
        result = await sending.client.sendText({ to: phone, body });
      }

      await this.finalizeOutbound(messageId, msg.conversationId, result.messageSid);
      return { ...result, conversationId: msg.conversationId, messageId };
    } catch (error: unknown) {
      await this.chatService.markOutboundFailed(
        messageId,
        extractErrorCode(error),
        extractErrorMessage(error),
      );
      rethrowWhatsAppProviderError(error);
    }
  }

  /**
   * Every outbound send touches routing state: an explicit `routingMode` pins the conversation to
   * that agent/flow/script, and the ABSENCE of one resets any previous pin so replies fall back to
   * the phone number's default WhatsAppInboundConfig. This is intentional — a send with no routing
   * is treated as "start fresh" for this conversation, not "leave whatever was there before."
   */
  private async applyReplyRoutingIfConfigured(
    conversationId: string,
    ctx: SendOutboundContext,
  ): Promise<void> {
    const routing = toReplyRoutingConfig(ctx.replyRouting);
    if (routing) {
      await this.chatService.applyReplyRouting(conversationId, routing);
      return;
    }

    await this.chatService.resetReplyRouting(conversationId);
  }

  private async prepareConversation(
    phone: string,
    sending: SendingContext,
  ): Promise<{
    conversation: WhatsAppConversation;
    companyId: string | null;
    contactId: string | null;
  }> {
    const { companyId, metaPhoneNumberId } = sending;

    if (companyId) {
      const contact = await this.contactService.findOrCreateByPhone(companyId, phone);
      const conversation = await this.conversationService.findOrCreate({
        companyId,
        contactId: contact.id,
        phoneNumber: phone,
        metaPhoneNumberId,
      });
      return { conversation, companyId, contactId: contact.id };
    }

    const conversation = await this.chatService.findOrCreateConversation({
      contactPhone: phone,
      metaPhoneNumberId,
      companyId: null,
    });
    this.logger.warn(
      `Outbound to ${phone} without companyId — conversation ${conversation.id} may not appear in tenant lists`,
    );
    return { conversation, companyId: null, contactId: null };
  }

  private resolveOutboundTemplateFallback(
    ctx: SendOutboundContext,
  ): { templateName: string; languageCode: string } | null {
    const cfg = this.nestConfig.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const templateName = ctx.templateName?.trim() ?? cfg?.defaultOutboundTemplateName.trim() ?? '';
    if (!templateName) {
      return null;
    }
    const languageCode =
      ctx.templateLanguage?.trim() ??
      cfg?.defaultOutboundTemplateLanguage.trim() ??
      cfg?.metaDefaultLanguage ??
      'en';
    return { templateName, languageCode };
  }

  private async finalizeOutbound(
    messageId: string,
    conversationId: string,
    metaWamid: string,
  ): Promise<void> {
    if (metaWamid) {
      await this.chatService.attachOutboundWamid(messageId, metaWamid);
    } else {
      this.logger.warn(
        `Outbound message ${messageId} sent without Meta wamid — status webhooks will not match`,
      );
    }
    await this.chatService.touchOutboundActivity(conversationId);
    await this.chatService.syncConversationLifecycle(conversationId, 'outbound_sent');
  }

  private async resolveSendingContext(ctx: SendOutboundContext): Promise<SendingContext> {
    let companyId = ctx.companyId ?? null;
    const globalPhoneId = this.resolveGlobalMetaPhoneNumberId();

    if (!companyId) {
      try {
        const row = await this.companyConfig.getByPhoneNumberId(globalPhoneId);
        companyId = row?.companyId ?? null;
      } catch {
        /* no row */
      }
      if (!companyId) {
        const routing = await this.inboundConfig.resolve(globalPhoneId);
        companyId = routing.companyId;
      }
    }

    if (companyId) {
      try {
        const config = await this.companyConfig.getActiveConfigOrThrow(companyId);
        return {
          companyId,
          client: this.companyConfig.createMetaClient(config),
          metaPhoneNumberId: config.phoneNumberId,
        };
      } catch (err) {
        this.logger.warn(
          `Company ${companyId} WhatsApp config unavailable, falling back to global client: ${(err as Error).message}`,
        );
      }
    }

    return {
      companyId,
      client: this.assertGlobalClient(),
      metaPhoneNumberId: globalPhoneId,
    };
  }

  private assertGlobalClient(): WhatsAppClientLike {
    if (!this.client) {
      throw new BadRequestException('WhatsApp is not configured');
    }
    return this.client;
  }

  private resolveGlobalMetaPhoneNumberId(): string {
    const cfg = this.nestConfig.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    const id = cfg?.metaPhoneNumberId.trim();
    if (!id) {
      throw new BadRequestException('WHATSAPP_META_PHONE_NUMBER_ID is not configured');
    }
    return id;
  }

  private normalizePhone(to: string): string {
    const phone = normalizePhoneNumber(to);
    if (!phone) {
      throw new BadRequestException('Invalid recipient phone number');
    }
    return phone;
  }
}

function extractErrorCode(error: unknown): string | undefined {
  if (error instanceof MetaWhatsAppApiError && error.code != null) {
    return String(error.code);
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Send failed';
}

const OUTSIDE_WINDOW_NO_TEMPLATE_MESSAGE =
  "Outside the 24-hour customer service window. WhatsApp only delivers free-form messages within 24 hours of the customer's last message. " +
  'To message first, use an approved template: POST /whatsapp/templates, or set templateName on POST /whatsapp/messages, ' +
  'or configure WHATSAPP_DEFAULT_OUTBOUND_TEMPLATE_NAME (utility template with {{1}} for message body).';
