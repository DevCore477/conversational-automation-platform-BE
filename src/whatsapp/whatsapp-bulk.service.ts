import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WhatsAppCampaignStatus, WhatsAppJobType } from '../common/enums/whatsapp.enum';
import whatsappConfig from '../configs/whatsapp.config';
import { WhatsAppCampaign } from '../models/whatsapp/whatsapp-campaign.entity';
import type {
  BulkRecipientRow,
  BulkSendOptions,
  BulkSendResult,
  BulkSendResultItem,
  WhatsAppMessageDesign,
} from './types/message-design.types';
import { WhatsAppMessageDesignSchema } from './types/message-design.types';
import {
  collectCsvVariableKeys,
  csvRecordsToRecipients,
  parseCsvToRecords,
} from './utils/csv-recipients.util';
import {
  applyVariablesToDesign,
  extractPlaceholderKeys,
  renderPlaceholders,
} from './utils/message-builder.util';
import { WhatsAppConfigService } from './services/whatsapp-config.service';
import { WhatsAppContactService } from './services/whatsapp-contact.service';
import { WhatsAppConversationService } from './services/whatsapp-conversation.service';
import { WhatsAppMessageLogService } from './services/whatsapp-message-log.service';
import { WhatsAppChatService } from './services/whatsapp-chat.service';
import { WhatsAppQueueService } from './services/whatsapp-queue.service';
import { WhatsAppTemplateService } from './services/whatsapp-template.service';
import { resolveDesignOutboundStorage } from './utils/whatsapp-outbound-storage.util';
import { toReplyRoutingConfig } from './utils/whatsapp-reply-routing.util';

@Injectable()
export class WhatsAppBulkService {
  private readonly logger = new Logger(WhatsAppBulkService.name);

  constructor(
    private readonly queueService: WhatsAppQueueService,
    @InjectRepository(WhatsAppCampaign)
    private readonly campaignRepo: Repository<WhatsAppCampaign>,
    private readonly configService: ConfigService,
    private readonly companyConfig: WhatsAppConfigService,
    private readonly contactService: WhatsAppContactService,
    private readonly conversationService: WhatsAppConversationService,
    private readonly messageLog: WhatsAppMessageLogService,
    private readonly chatService: WhatsAppChatService,
    private readonly templateService: WhatsAppTemplateService,
  ) {}

  private get bulkConfig() {
    return this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
  }

  private resolveDelayMs(requested?: number): number {
    const cfg = this.bulkConfig;
    const delay = requested ?? cfg?.bulkDefaultDelayMs ?? 800;
    const max = cfg?.bulkMaxDelayMs ?? 10000;
    return Math.min(Math.max(delay, 0), max);
  }

  private assertRecipientLimit(count: number): void {
    const max = this.bulkConfig?.bulkMaxRecipients ?? 5000;
    if (count > max) {
      throw new BadRequestException(
        `Bulk send limited to ${max.toString()} recipients per campaign. Got ${count.toString()}.`,
      );
    }
  }

  parseDesign(input: unknown): WhatsAppMessageDesign {
    const parsed = WhatsAppMessageDesignSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return parsed.data;
  }

  parseCsvBuffer(buffer: Buffer): BulkRecipientRow[] {
    const content = buffer.toString('utf8');
    const records = parseCsvToRecords(content);
    return csvRecordsToRecipients(records);
  }

  private parseCsvRecords(buffer: Buffer): Record<string, string>[] {
    return parseCsvToRecords(buffer.toString('utf8'));
  }

  private assertCsvCoversDesignPlaceholders(
    records: Record<string, string>[],
    design: WhatsAppMessageDesign,
    recipients: BulkRecipientRow[],
  ): void {
    const csvColumns = collectCsvVariableKeys(records);
    const csvLower = new Set(csvColumns.map(c => c.toLowerCase()));
    const required = new Set(extractDesignPlaceholderKeys(design));

    if (design.type === 'text' && design.body.includes('{{message}}')) {
      const sampleMessage = recipients.find(r => r.message?.trim())?.message;
      if (sampleMessage) {
        for (const key of extractPlaceholderKeys(sampleMessage)) {
          required.add(key);
        }
      }
    }

    const missing = [...required].filter(
      key => key.toLowerCase() !== 'message' && !csvLower.has(key.toLowerCase()),
    );
    if (missing.length === 0) {
      return;
    }
    throw new BadRequestException(
      `CSV is missing column(s) for placeholder(s): ${missing.map(k => `{{${k}}}`).join(', ')}. ` +
        `Found columns: ${csvColumns.join(', ') || '(none)'}. ` +
        'Add a header per variable (e.g. name, from, date, credit) — values are substituted per row.',
    );
  }

  async sendBulk(params: {
    design: unknown;
    recipients: BulkRecipientRow[];
    options?: BulkSendOptions;
    companyId?: string;
    campaignName?: string;
  }): Promise<BulkSendResult> {
    const design = this.parseDesign(params.design);
    return this.enqueueCampaign(
      design,
      params.recipients,
      params.options,
      params.companyId,
      params.campaignName,
    );
  }

  async sendBulkFromCsv(params: {
    file: Buffer;
    design?: unknown;
    options?: BulkSendOptions;
    companyId?: string;
  }): Promise<BulkSendResult> {
    const records = this.parseCsvRecords(params.file);
    const recipients = csvRecordsToRecipients(records);

    let design: WhatsAppMessageDesign;
    if (params.design) {
      design = this.parseDesign(params.design);
    } else if (recipients.some(r => r.message)) {
      design = { type: 'text', body: '{{message}}' };
    } else {
      throw new BadRequestException(
        'Provide a `design` JSON field or include a `message` column in the CSV',
      );
    }

    this.assertCsvCoversDesignPlaceholders(records, design, recipients);

    return this.enqueueCampaign(design, recipients, params.options, params.companyId, 'CSV upload');
  }

  async sendBulkText(params: {
    defaultMessage: string;
    recipients: BulkRecipientRow[];
    options?: BulkSendOptions;
    companyId?: string;
  }): Promise<BulkSendResult> {
    return this.sendBulk({
      design: { type: 'text', body: params.defaultMessage },
      recipients: params.recipients,
      options: params.options,
      companyId: params.companyId,
    });
  }

  async getCampaignStatus(campaignId: string): Promise<WhatsAppCampaign | null> {
    return this.campaignRepo.findOne({ where: { id: campaignId } });
  }

  private async enqueueCampaign(
    baseDesign: WhatsAppMessageDesign,
    recipients: BulkRecipientRow[],
    options: BulkSendOptions = {},
    companyId?: string,
    campaignName?: string,
  ): Promise<BulkSendResult> {
    this.assertRecipientLimit(recipients.length);

    const dryRun = options.dryRun === true;
    const delayMs = this.resolveDelayMs(options.delayMs);
    const results: BulkSendResultItem[] = [];
    const replyRouting = toReplyRoutingConfig(options);

    const campaign = await this.campaignRepo.save(
      this.campaignRepo.create({
        companyId: companyId ?? null,
        name: campaignName ?? null,
        status: dryRun ? WhatsAppCampaignStatus.COMPLETED : WhatsAppCampaignStatus.QUEUED,
        designType: baseDesign.type,
        totalCount: recipients.length,
        dryRun,
        completedAt: dryRun ? new Date() : null,
        routingMode: replyRouting?.routingMode ?? null,
        agentId: replyRouting?.agentId ?? null,
        flowId: replyRouting?.flowId ?? null,
        scriptId: replyRouting?.scriptId ?? null,
        aiModel: replyRouting?.aiModel ?? null,
        aiSystemPrompt: replyRouting?.aiSystemPrompt ?? null,
      }),
    );

    const jobs: Parameters<WhatsAppQueueService['enqueueMany']>[0] = [];
    const baseTime = Date.now();
    const companyConfig = companyId
      ? await this.companyConfig.getActiveConfigOrThrow(companyId).catch(() => null)
      : null;

    let templateMeta: { templateId?: string; bodyPreview?: string | null } | null = null;
    if (baseDesign.type === 'template' && companyId) {
      const row = await this.templateService.findByMetaName(companyId, baseDesign.templateName);
      if (row) {
        templateMeta = { templateId: row.id, bodyPreview: row.bodyPreview };
      }
    }

    for (let i = 0; i < recipients.length; i++) {
      const row = recipients[i];
      const rowVars: Record<string, string> = {
        ...row.variables,
        ...(row.message ? { message: row.message } : {}),
      };

      let design = applyVariablesToDesign(baseDesign, rowVars);
      if (design.type === 'template' && row.parameters?.length) {
        design = { ...design, parameters: row.parameters };
      }
      if (
        design.type === 'text' &&
        row.message &&
        baseDesign.type === 'text' &&
        !baseDesign.body.includes('{{message}}')
      ) {
        design = { type: 'text', body: renderPlaceholders(row.message, rowVars) };
      }

      const storage = resolveDesignOutboundStorage(design, rowVars, templateMeta);
      const preview = storage.body;
      results.push({ to: row.to, success: true, preview });

      if (dryRun) {
        continue;
      }

      let conversationId: string | null = null;
      let messageLogId: string | undefined;
      let contactId: string | undefined;

      if (companyId && companyConfig) {
        try {
          const phone = this.contactService.normalizePhone(row.to);
          const contact = await this.contactService.findOrCreateByPhone(companyId, phone);
          const conversation = await this.conversationService.findOrCreate({
            companyId,
            contactId: contact.id,
            phoneNumber: phone,
            metaPhoneNumberId: companyConfig.phoneNumberId,
          });
          // No routingMode on this bulk send resets any previously-pinned routing for the
          // recipient's conversation — consistent with single/template sends.
          if (replyRouting) {
            await this.chatService.applyReplyRouting(conversation.id, replyRouting);
          } else {
            await this.chatService.resetReplyRouting(conversation.id);
          }
          const log = await this.messageLog.createQueuedOutbound({
            companyId,
            contactId: contact.id,
            conversationId: conversation.id,
            campaignId: campaign.id,
            phoneNumber: phone,
            messageType: design.type,
            body: storage.body,
            templateName: storage.templateName ?? undefined,
            payload: storage.payload ?? undefined,
          });
          conversationId = conversation.id;
          messageLogId = log.id;
          contactId = contact.id;
        } catch (err) {
          this.logger.warn(
            `Bulk row ${row.to}: could not provision conversation — ${(err as Error).message}`,
          );
        }
      }

      jobs.push({
        jobType: WhatsAppJobType.BULK_SEND,
        campaignId: campaign.id,
        conversationId,
        payload: {
          to: row.to,
          design,
          variables: rowVars,
          companyId: companyId ?? null,
          metaPhoneNumberId:
            companyConfig?.phoneNumberId ?? this.bulkConfig?.metaPhoneNumberId ?? '',
          conversationId,
          messageLogId,
          contactId,
        },
        scheduledAt: new Date(baseTime + i * delayMs),
        priority: 0,
        dedupeKey: `bulk:${campaign.id}:${row.to}`,
      });
    }

    if (!dryRun && jobs.length > 0) {
      await this.queueService.enqueueMany(jobs);
      campaign.status = WhatsAppCampaignStatus.RUNNING;
      await this.campaignRepo.save(campaign);
    }

    this.logger.log(
      `Bulk campaign ${campaign.id}: ${recipients.length.toString()} recipients queued (dryRun=${String(dryRun)})`,
    );

    return {
      campaignId: campaign.id,
      total: recipients.length,
      sent: dryRun ? recipients.length : 0,
      failed: 0,
      skipped: 0,
      dryRun,
      designType: baseDesign.type,
      results,
    };
  }
}

function extractDesignPlaceholderKeys(design: WhatsAppMessageDesign): string[] {
  const parts: string[] = [];
  switch (design.type) {
    case 'text':
      parts.push(design.body);
      break;
    case 'template':
      parts.push(...(design.parameters ?? []));
      break;
    case 'media':
      if (design.caption) {
        parts.push(design.caption);
      }
      break;
    case 'interactive_buttons':
      parts.push(design.body);
      if (design.header?.text) {
        parts.push(design.header.text);
      }
      if (design.footer) {
        parts.push(design.footer);
      }
      break;
    case 'interactive_list':
      parts.push(design.body);
      if (design.footer) {
        parts.push(design.footer);
      }
      break;
    default:
      break;
  }
  return [...new Set(parts.flatMap(text => extractPlaceholderKeys(text)))];
}
