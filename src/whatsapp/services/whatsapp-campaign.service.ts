import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { WhatsAppCampaignStatus, WhatsAppMessageDirection } from '../../common/enums/whatsapp.enum';
import whatsappConfig from '../../configs/whatsapp.config';
import { WhatsAppCampaign } from '../../models/whatsapp/whatsapp-campaign.entity';
import { WhatsAppContact } from '../../models/whatsapp/whatsapp-contact.entity';
import { WhatsAppMessage } from '../../models/whatsapp/whatsapp-message.entity';
import { WhatsAppOutboundQueueService } from '../queues/whatsapp-outbound.queue';
import type { CampaignRecipientInput } from '../types/campaign-recipient.types';
import {
  dedupeCampaignRecipients,
  normalizeRecipientList,
} from '../utils/campaign-recipients.util';
import { WhatsAppChatService } from './whatsapp-chat.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import { WhatsAppContactService } from './whatsapp-contact.service';
import { WhatsAppConversationService } from './whatsapp-conversation.service';
import { WhatsAppMessageLogService } from './whatsapp-message-log.service';
import {
  WhatsAppTemplateService,
  type WhatsAppTemplateResponse,
} from './whatsapp-template.service';
import { templateToResponse } from './whatsapp-template.mapper';
import {
  extractNamedBodyParamNames,
  resolveCampaignTemplateSendVars,
  type CampaignTemplateSendVars,
} from '../utils/whatsapp-template-send.util';
import type { WhatsAppReplyRoutingInput } from '../types/whatsapp-reply-routing.types';
import { toReplyRoutingConfig } from '../utils/whatsapp-reply-routing.util';
import {
  buildTemplateMessagePreview,
  extractMessageTemplateParameterValues,
  extractTemplatePlaceholderNames,
  extractTemplateSendVarsFromPayload,
  resolveMessageDisplayBody,
  toTemplateDisplayInfo,
  type TemplateDisplayInfo,
} from '../utils/whatsapp-message-display.util';

export interface CampaignRecipientDetail {
  messageId: string;
  contactId: string | null;
  contactName: string | null;
  phoneNumber: string;
  status: string;
  body: string | null;
  templateName: string | null;
  template: TemplateDisplayInfo | null;
  templateParameters: string[];
  errorCode: string | null;
  errorMessage: string | null;
  conversationId: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  isDeleted: boolean;
}

export interface CampaignDetailsResponse {
  campaign: {
    id: string;
    companyId: string | null;
    name: string | null;
    status: WhatsAppCampaignStatus;
    designType: string | null;
    templateId: string | null;
    templateVariableMapping: Record<string, string> | null;
    scheduledAt: Date | null;
    createdByUserId: string | null;
    pauseReason: string | null;
    dryRun: boolean;
    totalCount: number;
    queuedCount: number;
    sentCount: number;
    failedCount: number;
    deliveredCount: number;
    readCount: number;
    skippedCount: number;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
    routingMode: string | null;
    agentId: string | null;
    flowId: string | null;
    scriptId: string | null;
    aiModel: string | null;
    aiSystemPrompt: string | null;
  };
  template: WhatsAppTemplateResponse | null;
  message: {
    designType: string | null;
    preview: string | null;
    templateName: string | null;
    template: TemplateDisplayInfo | null;
    templateParameters: string[];
    variableMapping: Record<string, string> | null;
  };
  recipients: {
    data: CampaignRecipientDetail[];
    meta: {
      currentPage: number;
      itemsPerPage: number;
      totalItems: number;
      deletedCount: number;
      activeCount: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
  };
}

export interface CreateCampaignInput {
  name: string;
  templateId: string;
  /** Phone numbers / CSV rows — external recipients, not Hexa users */
  recipients?: CampaignRecipientInput[];
  phones?: string[];
  /** Optional existing whatsapp_contacts ids for this company */
  contactIds?: string[];
  templateParamsByPhone?: Record<string, string[]>;
  templateParamsByContact?: Record<string, string[]>;
  templateVariableMapping?: Record<string, string>;
  /** When true, mark imported numbers as opted-in (company asserts consent) */
  confirmRecipientsOptedIn?: boolean;
  scheduledAt?: Date;
  createdByUserId?: string;
  replyRouting?: WhatsAppReplyRoutingInput;
}

export interface CampaignEnqueueSummary {
  campaignId: string;
  totalContacts: number;
  queued: number;
  skipped: number;
  failed: number;
  skipReasons: Record<string, number>;
  invalidPhones: string[];
}

@Injectable()
export class WhatsAppCampaignService {
  private readonly logger = new Logger(WhatsAppCampaignService.name);

  constructor(
    @InjectRepository(WhatsAppCampaign)
    private readonly campaignRepo: Repository<WhatsAppCampaign>,
    @InjectRepository(WhatsAppMessage)
    private readonly messageRepo: Repository<WhatsAppMessage>,
    private readonly templateService: WhatsAppTemplateService,
    private readonly contactService: WhatsAppContactService,
    private readonly conversationService: WhatsAppConversationService,
    private readonly messageLog: WhatsAppMessageLogService,
    private readonly configService: WhatsAppConfigService,
    private readonly outboundQueue: WhatsAppOutboundQueueService,
    private readonly nestConfig: ConfigService,
    private readonly chatService: WhatsAppChatService,
  ) {}

  async createAndEnqueue(
    companyId: string,
    input: CreateCampaignInput,
  ): Promise<CampaignEnqueueSummary> {
    const recipientRows = normalizeRecipientList(input.recipients, input.phones);
    const max =
      this.nestConfig.get<ConfigType<typeof whatsappConfig>>('whatsapp')?.bulkMaxRecipients ?? 5000;

    const optInOnImport = input.confirmRecipientsOptedIn === true;
    if (!optInOnImport && !input.contactIds?.length) {
      throw new BadRequestException(
        'confirmRecipientsOptedIn must be true when sending to phone numbers you provide. ' +
          'This confirms recipients have opted in to WhatsApp messages from your company.',
      );
    }

    const template = await this.templateService.getApprovedEntity(companyId, input.templateId);
    const companyConfig = await this.configService.getActiveConfigOrThrow(companyId);

    const contacts: WhatsAppContact[] = [];
    const invalidPhones: string[] = [];

    if (recipientRows.length > 0) {
      for (const row of dedupeCampaignRecipients(recipientRows)) {
        try {
          const contact = await this.contactService.findOrCreateByPhone(
            companyId,
            row.phone,
            row.name,
            {
              optIn: optInOnImport,
              optInSource: 'campaign_import',
            },
          );
          contacts.push(contact);
        } catch {
          invalidPhones.push(row.phone);
        }
      }
    }

    if (input.contactIds?.length) {
      const existing = await this.contactService.findByIds(companyId, input.contactIds);
      if (existing.length !== input.contactIds.length) {
        throw new BadRequestException(
          'One or more contactIds are invalid or belong to another company',
        );
      }
      const seen = new Set(contacts.map(c => c.id));
      for (const c of existing) {
        if (!seen.has(c.id)) {
          contacts.push(c);
        }
      }
    }

    if (contacts.length === 0) {
      throw new BadRequestException('No valid recipients after parsing phone numbers');
    }

    if (contacts.length > max) {
      throw new BadRequestException(`Maximum ${String(max)} recipients per campaign`);
    }

    // commented working for verifying params for campaigns
    // const namedParamNames = extractNamedBodyParamNames(template.components);
    // const templateSendVarsByPhone = this.buildTemplateSendVarsLookup(
    //   input,
    //   recipientRows,
    //   namedParamNames,
    // );

    const namedParamNames = extractNamedBodyParamNames(template.components);

    const requiredTemplateParamKeys = this.extractRequiredTemplateParamKeys(
      template.components,
      template.bodyPreview,
    );

    const templateSendVarsByPhone = this.buildTemplateSendVarsLookup(
      input,
      recipientRows,
      namedParamNames,
    );

    // const templateValidationRows = contacts.map(contact => {
    //   const sendVars =
    //     templateSendVarsByPhone.get(contact.phoneNumber) ??
    //     templateSendVarsFromContactInput(input, contact.id, namedParamNames) ??
    //     templateSendVarsFromMapping(input.templateVariableMapping, contact, namedParamNames);
    //
    //   return {
    //     phoneNumber: contact.phoneNumber,
    //     sendVars,
    //   };
    // });
    //
    // this.validateCampaignTemplateParamsOrThrow(
    //   template.metaTemplateName,
    //   requiredTemplateParamKeys,
    //   templateValidationRows,
    // );
    const normalizedSendVarsByContactId = new Map<
      string,
      {
        parameters?: unknown[];
        contentVariables?: Record<string, unknown>;
      }
    >();

    const templateValidationRows = contacts.map(contact => {
      const rawSendVars =
        templateSendVarsByPhone.get(contact.phoneNumber) ??
        templateSendVarsFromContactInput(input, contact.id, namedParamNames) ??
        templateSendVarsFromMapping(input.templateVariableMapping, contact, namedParamNames);

      const sendVars = this.normalizeNamedTemplateVars(
        rawSendVars,
        requiredTemplateParamKeys,
        contact,
      );

      if (sendVars) {
        normalizedSendVarsByContactId.set(contact.id, sendVars);
      }

      return {
        phoneNumber: contact.phoneNumber,
        sendVars,
      };
    });

    this.validateCampaignTemplateParamsOrThrow(
      template.metaTemplateName,
      requiredTemplateParamKeys,
      templateValidationRows,
    );

    const replyRouting = toReplyRoutingConfig(input.replyRouting);

    const campaign = await this.campaignRepo.save(
      this.campaignRepo.create({
        companyId,
        name: input.name,
        templateId: template.id,
        templateVariableMapping: input.templateVariableMapping ?? null,
        status: WhatsAppCampaignStatus.QUEUED,
        designType: 'template',
        totalCount: contacts.length,
        scheduledAt: input.scheduledAt ?? null,
        createdByUserId: input.createdByUserId ?? null,
        routingMode: replyRouting?.routingMode ?? null,
        agentId: replyRouting?.agentId ?? null,
        flowId: replyRouting?.flowId ?? null,
        scriptId: replyRouting?.scriptId ?? null,
        aiModel: replyRouting?.aiModel ?? null,
        aiSystemPrompt: replyRouting?.aiSystemPrompt ?? null,
      }),
    );

    const skipReasons: Record<string, number> = {};
    let queued = 0;
    let skipped = 0;
    const queueItems: Parameters<WhatsAppOutboundQueueService['enqueueMany']>[0] = [];
    const baseDelay = 800;

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const eligibility = this.contactService.checkEligibility(contact);
      if (!eligibility.eligible) {
        skipped++;
        const reason = eligibility.skipReason ?? 'unknown';
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        continue;
      }

      const conversation = await this.conversationService.findOrCreate({
        companyId,
        contactId: contact.id,
        phoneNumber: contact.phoneNumber,
        metaPhoneNumberId: companyConfig.phoneNumberId,
      });

      // No routingMode on this campaign resets any previously-pinned routing for the recipient's
      // conversation — consistent with single/template sends: no routing chosen means start fresh.
      if (replyRouting) {
        await this.chatService.applyReplyRouting(conversation.id, replyRouting);
      } else {
        await this.chatService.resetReplyRouting(conversation.id);
      }

      const sendVars =
        templateSendVarsByPhone.get(contact.phoneNumber) ??
        templateSendVarsFromContactInput(input, contact.id, namedParamNames) ??
        templateSendVarsFromMapping(input.templateVariableMapping, contact, namedParamNames);

      const previewBody = buildTemplateMessagePreview(
        template.bodyPreview,
        sendVars,
        template.metaTemplateName,
      );

      const log = await this.messageLog.createQueuedOutbound({
        companyId,
        contactId: contact.id,
        conversationId: conversation.id,
        campaignId: campaign.id,
        phoneNumber: contact.phoneNumber,
        messageType: 'template',
        templateName: template.metaTemplateName,
        body: previewBody,
        payload: {
          templateId: template.id,
          templateSendVars: sendVars,
        },
      });

      queueItems.push({
        payload: {
          companyId,
          contactId: contact.id,
          campaignId: campaign.id,
          conversationId: conversation.id,
          phoneNumber: contact.phoneNumber,
          messageType: 'template',
          templateName: template.metaTemplateName,
          templateLanguage: template.language,
          templateParams: sendVars?.parameters,
          templateContentVariables: sendVars?.contentVariables,
          templateComponents: template.components,
          templateBodyPreview: template.bodyPreview,
          messageLogId: log.id,
        },
        delayMs: i * baseDelay,
      });
      queued++;
    }

    if (queueItems.length > 0) {
      await this.outboundQueue.enqueueMany(queueItems);
    }

    campaign.queuedCount = queued;
    campaign.skippedCount = skipped;
    campaign.status =
      queued > 0 ? WhatsAppCampaignStatus.SENDING : WhatsAppCampaignStatus.COMPLETED;
    await this.campaignRepo.save(campaign);

    this.logger.log(
      `Campaign ${campaign.id} for company ${companyId}: queued=${String(queued)} skipped=${String(skipped)} invalidPhones=${String(invalidPhones.length)}`,
    );

    return {
      campaignId: campaign.id,
      totalContacts: contacts.length,
      queued,
      skipped,
      failed: 0,
      skipReasons,
      invalidPhones,
    };
  }

  private buildTemplateSendVarsLookup(
    input: CreateCampaignInput,
    recipientRows: CampaignRecipientInput[],
    namedParamNames: string[],
  ): Map<string, CampaignTemplateSendVars> {
    const map = new Map<string, CampaignTemplateSendVars>();

    for (const row of recipientRows) {
      try {
        const phone = this.contactService.normalizePhone(row.phone);
        const sendVars = resolveCampaignTemplateSendVars(row, namedParamNames);
        if (sendVars.parameters?.length || sendVars.contentVariables) {
          map.set(phone, sendVars);
        }
      } catch {
        /* skip invalid */
      }
    }

    if (input.templateParamsByPhone) {
      for (const [phone, params] of Object.entries(input.templateParamsByPhone)) {
        try {
          const normalizedPhone = this.contactService.normalizePhone(phone);
          const row = recipientRows.find(r => {
            try {
              return this.contactService.normalizePhone(r.phone) === normalizedPhone;
            } catch {
              return false;
            }
          });
          map.set(
            normalizedPhone,
            resolveCampaignTemplateSendVars(
              { templateParams: params, variables: row?.variables },
              namedParamNames,
            ),
          );
        } catch {
          /* skip */
        }
      }
    }

    return map;
  }

  async listForCompany(companyId: string, limit = 50, offset = 0): Promise<WhatsAppCampaign[]> {
    return this.campaignRepo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async getById(campaignId: string, companyId?: string): Promise<WhatsAppCampaign> {
    return this.findCampaignOrThrow(campaignId, companyId);
  }

  async update(
    campaignId: string,
    input: { name?: string },
    companyId?: string,
  ): Promise<WhatsAppCampaign> {
    const campaign = await this.findCampaignOrThrow(campaignId, companyId);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException('Campaign name cannot be empty');
      }
      campaign.name = name;
    }

    return this.campaignRepo.save(campaign);
  }

  async delete(campaignId: string, companyId?: string): Promise<{ deleted: true; id: string }> {
    const campaign = await this.findCampaignOrThrow(campaignId, companyId);

    if (campaign.status === WhatsAppCampaignStatus.SENDING) {
      throw new BadRequestException('Cannot delete a campaign while it is still sending');
    }

    await this.campaignRepo.remove(campaign);
    return { deleted: true, id: campaignId };
  }

  async getDetails(
    campaignId: string,
    pagination: { page?: number; limit?: number } = {},
    companyId?: string,
  ): Promise<CampaignDetailsResponse> {
    const campaign = await this.campaignRepo.findOne({
      where: companyId ? { id: campaignId, companyId } : { id: campaignId },
      relations: { template: true },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    const resolvedCompanyId = campaign.companyId;
    if (!resolvedCompanyId) {
      throw new BadRequestException('Campaign has no company');
    }

    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 50;
    const skip = (page - 1) * limit;

    const recipientWhere = {
      campaignId: campaign.id,
      companyId: resolvedCompanyId,
      direction: WhatsAppMessageDirection.OUTBOUND,
    };

    const [messages, totalItems, deletedCount] = await Promise.all([
      this.messageRepo.find({
        where: recipientWhere,
        relations: { contact: true },
        order: { createdAt: 'ASC' },
        take: limit,
        skip,
      }),
      this.messageRepo.count({ where: recipientWhere }),
      this.messageRepo.count({
        where: { ...recipientWhere, deletedAt: Not(IsNull()) },
      }),
    ]);

    const sampleMessage =
      messages[0] ??
      (await this.messageRepo.findOne({
        where: {
          campaignId: campaign.id,
          companyId: resolvedCompanyId,
          direction: WhatsAppMessageDirection.OUTBOUND,
        },
        order: { createdAt: 'ASC' },
      }));

    let template: WhatsAppTemplateResponse | null = null;
    if (campaign.template) {
      template = templateToResponse(campaign.template);
    } else if (campaign.templateId) {
      try {
        template = await this.templateService.getById(resolvedCompanyId, campaign.templateId);
      } catch {
        template = null;
      }
    }

    const templateInfo = template ? toTemplateDisplayInfo(template) : null;
    const templateName = template?.metaTemplateName ?? sampleMessage.templateName ?? null;
    const sampleSendVars = extractTemplateSendVarsFromPayload(sampleMessage.payload);
    const preview = sampleMessage
      ? resolveMessageDisplayBody(sampleMessage.body, templateInfo, sampleSendVars)
      : buildTemplateMessagePreview(template?.bodyPreview, undefined, templateName);
    const templateParamOrder = extractTemplatePlaceholderNames(
      template?.components,
      template?.bodyPreview,
    );
    const sampleTemplateParameters = extractMessageTemplateParameterValues(
      sampleSendVars,
      templateParamOrder,
    );

    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / limit);

    return {
      campaign: {
        id: campaign.id,
        companyId: campaign.companyId,
        name: campaign.name,
        status: campaign.status,
        designType: campaign.designType,
        templateId: campaign.templateId,
        templateVariableMapping: campaign.templateVariableMapping,
        scheduledAt: campaign.scheduledAt,
        createdByUserId: campaign.createdByUserId,
        pauseReason: campaign.pauseReason,
        dryRun: campaign.dryRun,
        totalCount: campaign.totalCount,
        queuedCount: campaign.queuedCount,
        sentCount: campaign.sentCount,
        failedCount: campaign.failedCount,
        deliveredCount: campaign.deliveredCount,
        readCount: campaign.readCount,
        skippedCount: campaign.skippedCount,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        completedAt: campaign.completedAt,
        routingMode: campaign.routingMode,
        agentId: campaign.agentId,
        flowId: campaign.flowId,
        scriptId: campaign.scriptId,
        aiModel: campaign.aiModel,
        aiSystemPrompt: campaign.aiSystemPrompt,
      },
      template,
      message: {
        designType: campaign.designType,
        preview,
        templateName,
        template: templateInfo,
        templateParameters: sampleTemplateParameters,
        variableMapping: campaign.templateVariableMapping,
      },
      recipients: {
        data: messages.map(msg => {
          const sendVars = extractTemplateSendVarsFromPayload(msg.payload);
          const templateParameters = extractMessageTemplateParameterValues(
            sendVars,
            templateParamOrder,
          );
          return {
            messageId: msg.id,
            contactId: msg.contactId,
            contactName: msg.contact?.name ?? null,
            phoneNumber: msg.phoneNumber ?? msg.contact?.phoneNumber ?? '',
            status: msg.status,
            body: resolveMessageDisplayBody(msg.body, templateInfo, sendVars),
            templateName: msg.templateName,
            template: templateInfo,
            templateParameters,
            errorCode: msg.errorCode,
            errorMessage: msg.errorMessage,
            conversationId: msg.conversationId,
            sentAt: msg.sentAt,
            deliveredAt: msg.deliveredAt,
            readAt: msg.readAt,
            failedAt: msg.failedAt,
            createdAt: msg.createdAt,
            deletedAt: msg.deletedAt,
            isDeleted: msg.deletedAt != null,
          };
        }),
        meta: {
          currentPage: page,
          itemsPerPage: limit,
          totalItems,
          deletedCount,
          activeCount: totalItems - deletedCount,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1 && totalPages > 0,
        },
      },
    };
  }

  async getStats(campaignId: string, companyId?: string) {
    const campaign = await this.findCampaignOrThrow(campaignId, companyId);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      totalContacts: campaign.totalCount,
      queued: campaign.queuedCount,
      sent: campaign.sentCount,
      delivered: campaign.deliveredCount,
      read: campaign.readCount,
      failed: campaign.failedCount,
      skipped: campaign.skippedCount,
      pauseReason: campaign.pauseReason,
      createdAt: campaign.createdAt,
      completedAt: campaign.completedAt,
    };
  }

  async getAllStats(companyId?: string) {
    if (!companyId) {
      return {
        totalCampaigns: 0,
        completedCampaigns: 0,
        totalContacts: 0,
        queued: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        skipped: 0,
      };
    }
    this.logger.debug('Getting all stats', companyId);
    const campaigns = await this.campaignRepo.find({
      where: { companyId },
    });

    if (!campaigns.length) {
      return {
        totalCampaigns: 0,
        completedCampaigns: 0,
        totalContacts: 0,
        queued: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        skipped: 0,
      };
    }

    return campaigns.reduce(
      (stats, campaign) => {
        stats.totalCampaigns += 1;

        if (campaign.completedAt) {
          stats.completedCampaigns += 1;
        }

        stats.totalContacts += campaign.totalCount ?? 0;
        stats.queued += campaign.queuedCount ?? 0;
        stats.sent += campaign.sentCount ?? 0;
        stats.delivered += campaign.deliveredCount ?? 0;
        stats.read += campaign.readCount ?? 0;
        stats.failed += campaign.failedCount ?? 0;
        stats.skipped += campaign.skippedCount ?? 0;

        return stats;
      },
      {
        totalCampaigns: 0,
        completedCampaigns: 0,
        totalContacts: 0,
        queued: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        skipped: 0,
      },
    );
  }
  async getAllCampaigns(companyId?: string) {
    if (!companyId) {
      return {
        campaignCount: 0,
      };
    }
    return this.campaignRepo.count({ where: { companyId } });
  }

  private async findCampaignOrThrow(
    campaignId: string,
    companyId?: string,
  ): Promise<WhatsAppCampaign> {
    const campaign = await this.campaignRepo.findOne({
      where: companyId ? { id: campaignId, companyId } : { id: campaignId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    return campaign;
  }

  private extractNumericTemplateParamCount(
    components: unknown,
    bodyPreview?: string | null,
  ): number {
    const texts: string[] = [];

    if (bodyPreview) {
      texts.push(bodyPreview);
    }

    const collectTexts = (value: unknown): void => {
      if (!value) return;

      if (typeof value === 'string') {
        texts.push(value);
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(collectTexts);
        return;
      }

      if (typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
          collectTexts(v);
        }
      }
    };

    collectTexts(components);

    let max = 0;
    const regex = /{{\s*(\d+)\s*}}/g;

    for (const text of texts) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        max = Math.max(max, Number(match[1]));
      }
    }

    return max;
  }

  private isTemplateValueEmpty(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && value.trim() === '') return true;

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;

      const possibleValue =
        obj.text ?? obj.value ?? obj.parameterValue ?? obj.payload ?? obj.content;

      if (possibleValue !== undefined) {
        return this.isTemplateValueEmpty(possibleValue);
      }
    }

    return false;
  }

  private extractRequiredTemplateParams(
    components: unknown,
    bodyPreview?: string | null,
  ): {
    named: string[];
    positions: number[];
  } {
    const texts: string[] = [];

    if (bodyPreview) {
      texts.push(bodyPreview);
    }

    const collectTexts = (value: unknown): void => {
      if (!value) return;

      if (typeof value === 'string') {
        texts.push(value);
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(collectTexts);
        return;
      }

      if (typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach(collectTexts);
      }
    };

    collectTexts(components);

    const named = new Set<string>();
    const positions = new Set<number>();

    const placeholderRegex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

    for (const text of texts) {
      let match: RegExpExecArray | null;

      while ((match = placeholderRegex.exec(text)) !== null) {
        const key = match[1];

        if (/^\d+$/.test(key)) {
          positions.add(Number(key));
        } else {
          named.add(key);
        }
      }
    }

    return {
      named: [...named],
      positions: [...positions].sort((a, b) => a - b),
    };
  }

  private isTemplateParamValueEmpty(value: unknown): boolean {
    if (value === undefined || value === null) return true;

    if (typeof value === 'string') {
      return value.trim() === '';
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;

      const nestedValue = obj.text ?? obj.value ?? obj.parameterValue ?? obj.payload ?? obj.content;

      if (nestedValue !== undefined) {
        return this.isTemplateParamValueEmpty(nestedValue);
      }
    }

    return false;
  }

  private readTemplateParamValue(
    sendVars:
      | {
          parameters?: unknown[];
          contentVariables?: Record<string, unknown>;
        }
      | null
      | undefined,
    key: string,
  ): unknown {
    if (!sendVars) return undefined;

    const contentVariables = sendVars.contentVariables ?? {};
    const parameters = sendVars.parameters ?? [];

    const normalizedKey = key.replace(/^{{\s*/, '').replace(/\s*}}$/, '');
    const isPosition = /^\d+$/.test(normalizedKey);

    if (isPosition) {
      const index = Number(normalizedKey) - 1;

      return (
        contentVariables[normalizedKey] ??
        contentVariables[`{{${normalizedKey}}}`] ??
        contentVariables[`param${normalizedKey}`] ??
        contentVariables[`parameter${normalizedKey}`] ??
        parameters[index]
      );
    }

    const matchedParam = parameters.find(param => {
      if (!param || typeof param !== 'object') return false;

      const paramObj = param as Record<string, unknown>;

      return (
        paramObj.parameter_name === normalizedKey ||
        paramObj.name === normalizedKey ||
        paramObj.key === normalizedKey
      );
    });

    return (
      contentVariables[normalizedKey] ?? contentVariables[`{{${normalizedKey}}}`] ?? matchedParam
    );
  }

  private getMissingTemplateParams(
    sendVars:
      | {
          parameters?: unknown[];
          contentVariables?: Record<string, unknown>;
        }
      | null
      | undefined,
    requiredParams: {
      named: string[];
      positions: number[];
    },
  ): string[] {
    const missing: string[] = [];

    for (const position of requiredParams.positions) {
      const value = this.readTemplateParamValue(sendVars, String(position));

      if (this.isTemplateParamValueEmpty(value)) {
        missing.push(`param${position}`);
      }
    }

    for (const name of requiredParams.named) {
      const value = this.readTemplateParamValue(sendVars, name);

      if (this.isTemplateParamValueEmpty(value)) {
        missing.push(name);
      }
    }

    return missing;
  }

  private extractRequiredTemplateParamKeys(
    components: unknown,
    bodyPreview?: string | null,
  ): string[] {
    const texts: string[] = [];

    if (bodyPreview) {
      texts.push(bodyPreview);
    }

    const collectTexts = (value: unknown): void => {
      if (!value) return;

      if (typeof value === 'string') {
        texts.push(value);
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(collectTexts);
        return;
      }

      if (typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach(collectTexts);
      }
    };

    collectTexts(components);

    const keys: string[] = [];
    const seen = new Set<string>();
    const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

    for (const text of texts) {
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        const key = match[1];

        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }

    return keys;
  }

  // private isEmptyTemplateValue(value: unknown): boolean {
  //   if (value === undefined || value === null) return true;
  //
  //   if (typeof value === 'string') {
  //     return value.trim() === '';
  //   }
  //
  //   if (typeof value === 'object') {
  //     const obj = value as Record<string, unknown>;
  //
  //     const nestedValue = obj.text ?? obj.value ?? obj.parameterValue ?? obj.payload ?? obj.content;
  //
  //     if (nestedValue !== undefined) {
  //       return this.isEmptyTemplateValue(nestedValue);
  //     }
  //   }
  //
  //   return false;
  // }

  private getParamValue(param: unknown): unknown {
    if (!param || typeof param !== 'object') {
      return param;
    }

    const obj = param as Record<string, unknown>;

    return obj.text ?? obj.value ?? obj.parameterValue ?? obj.payload ?? obj.content;
  }

  private getTemplateParamPlainValue(value: unknown): unknown {
    if (!value || typeof value !== 'object') {
      return value;
    }

    const obj = value as Record<string, unknown>;

    return obj.text ?? obj.value ?? obj.parameterValue ?? obj.payload ?? obj.content ?? value;
  }

  private isEmptyTemplateValue(value: unknown): boolean {
    const plainValue = this.getTemplateParamPlainValue(value);

    if (plainValue === undefined || plainValue === null) return true;

    if (typeof plainValue === 'string') {
      return plainValue.trim() === '';
    }

    return false;
  }

  private resolveTemplateParamValue(
    sendVars:
      | {
          parameters?: unknown[];
          contentVariables?: Record<string, unknown>;
        }
      | null
      | undefined,
    key: string,
  ): unknown {
    if (!sendVars) return undefined;

    const params = sendVars.parameters ?? [];
    const contentVariables = sendVars.contentVariables ?? {};

    const cleanKey = key.replace(/^{{\s*/, '').replace(/\s*}}$/, '');
    const isPosition = /^\d+$/.test(cleanKey);

    if (isPosition) {
      const index = Number(cleanKey) - 1;

      return (
        params[index] ??
        contentVariables[cleanKey] ??
        contentVariables[`param${cleanKey}`] ??
        contentVariables[`parameter${cleanKey}`] ??
        contentVariables[`{{${cleanKey}}}`]
      );
    }

    const namedParamFromArray = params.find(param => {
      if (!param || typeof param !== 'object') return false;

      const obj = param as Record<string, unknown>;

      return obj.parameter_name === cleanKey || obj.name === cleanKey || obj.key === cleanKey;
    });

    return contentVariables[cleanKey] ?? contentVariables[`{{${cleanKey}}}`] ?? namedParamFromArray;
  }

  private normalizeNamedTemplateVars(
    sendVars:
      | {
          parameters?: unknown[];
          contentVariables?: Record<string, unknown>;
        }
      | null
      | undefined,
    requiredKeys: string[],
    contact: WhatsAppContact,
  ):
    | {
        parameters?: unknown[];
        contentVariables?: Record<string, unknown>;
      }
    | undefined {
    const normalized = {
      parameters: sendVars?.parameters ?? [],
      contentVariables: {
        ...(sendVars?.contentVariables ?? {}),
      },
    };

    for (const key of requiredKeys) {
      if (/^\d+$/.test(key)) {
        continue;
      }

      let value = this.resolveTemplateParamValue(normalized, key);

      /**
       * Important:
       * CSV usually has `name` as recipient/contact name.
       * If template also has {{name}}, reuse contact.name as template variable.
       */
      if (this.isEmptyTemplateValue(value) && key === 'name') {
        value = (contact as { name?: string }).name;
      }

      if (!this.isEmptyTemplateValue(value)) {
        normalized.contentVariables[key] = this.getTemplateParamPlainValue(value);
      }
    }

    return normalized;
  }

  private validateCampaignTemplateParamsOrThrow(
    templateName: string,
    requiredKeys: string[],
    rows: {
      phoneNumber: string;
      sendVars:
        | {
            parameters?: unknown[];
            contentVariables?: Record<string, unknown>;
          }
        | null
        | undefined;
    }[],
  ): void {
    const errors: {
      phoneNumber: string;
      expectedParams: string[];
      missingParams: string[];
    }[] = [];

    for (const row of rows) {
      const missingParams: string[] = [];

      for (const key of requiredKeys) {
        const value = this.resolveTemplateParamValue(row.sendVars, key);

        if (this.isEmptyTemplateValue(value)) {
          missingParams.push(/^\d+$/.test(key) ? `param${key}` : key);
        }
      }

      /**
       * Only validate parameters.length for positional templates.
       * Named params can be sent through contentVariables, so params.length can be 0.
       */
      const positionalKeys = requiredKeys.filter(key => /^\d+$/.test(key));

      if (positionalKeys.length > 0) {
        const paramsCount = row.sendVars?.parameters?.length ?? 0;

        if (paramsCount !== positionalKeys.length) {
          const expectedParamNames = positionalKeys.map(key => `param${key}`);

          for (const expectedParamName of expectedParamNames) {
            if (!missingParams.includes(expectedParamName)) {
              missingParams.push(expectedParamName);
            }
          }
        }
      }

      if (missingParams.length > 0) {
        errors.push({
          phoneNumber: row.phoneNumber,
          expectedParams: requiredKeys.map(key => (/^\d+$/.test(key) ? `param${key}` : key)),
          missingParams,
        });
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        message:
          'Campaign CSV/template variables are invalid. Please provide all required template parameters before sending.',
        templateName,
        errors,
      });
    }
  }
}

function templateSendVarsFromContactInput(
  input: CreateCampaignInput,
  contactId: string,
  namedParamNames: string[],
): CampaignTemplateSendVars | undefined {
  const params = input.templateParamsByContact?.[contactId];
  if (!params?.length) {
    return undefined;
  }
  return resolveCampaignTemplateSendVars({ templateParams: params }, namedParamNames);
}

function templateSendVarsFromMapping(
  mapping: Record<string, string> | undefined,
  contact: WhatsAppContact,
  namedParamNames: string[],
): CampaignTemplateSendVars | undefined {
  if (!mapping || Object.keys(mapping).length === 0) {
    return undefined;
  }
  const keys = Object.keys(mapping).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      return na - nb;
    }
    return a.localeCompare(b);
  });
  const resolved = keys.map(slot => {
    const raw = mapping[slot] ?? '';
    return raw
      .replace(/\{\{name\}\}/gi, contact.name ?? contact.phoneNumber)
      .replace(/\{\{phone\}\}/gi, contact.phoneNumber);
  });
  return resolveCampaignTemplateSendVars({ templateParams: resolved }, namedParamNames);
}
