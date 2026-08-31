import { Injectable, Logger } from '@nestjs/common';

import { WhatsAppConfigService } from './whatsapp-config.service';
import { WhatsAppTemplateService } from './whatsapp-template.service';

export interface MetaTemplateWebhookValue {
  event?: string;
  message_template_id?: string;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
  new_category?: string;
  previous_category?: string;
  new_quality_score?: string;
  previous_quality_score?: string;
  disable_info?: { reason?: string };
}

@Injectable()
export class WhatsAppTemplateWebhookService {
  private readonly logger = new Logger(WhatsAppTemplateWebhookService.name);

  constructor(
    private readonly configService: WhatsAppConfigService,
    private readonly templateService: WhatsAppTemplateService,
  ) {}

  async handleTemplateFieldChange(
    wabaId: string,
    field: string,
    value: MetaTemplateWebhookValue,
  ): Promise<void> {
    const companyId = await this.resolveCompanyIdByWaba(wabaId);
    if (!companyId) {
      this.logger.warn(`Template webhook: no company for WABA ${wabaId} field=${field}`);
      return;
    }

    const name = value.message_template_name;
    const language = value.message_template_language ?? 'en';
    if (!name) {
      this.logger.debug(`Template webhook ${field}: missing template name`);
      return;
    }

    const status = mapWebhookEventToStatus(field, value.event);
    const rejectionReason =
      value.reason ?? value.disable_info?.reason ?? undefined;

    await this.templateService.applyWebhookStatusUpdate({
      companyId,
      metaTemplateName: name,
      language,
      status,
      metaTemplateId: value.message_template_id,
      rejectionReason,
      category: value.new_category,
      qualityStatus: value.new_quality_score,
    });

    this.logger.log(
      `Template webhook ${field} company=${companyId} template=${name} status=${status}`,
    );
  }

  private async resolveCompanyIdByWaba(wabaId: string): Promise<string | null> {
    if (!wabaId) {
      return null;
    }
    const row = await this.configService.getByWabaId(wabaId);
    if (row?.companyId) {
      return row.companyId;
    }
    const configs = await this.configService.findAllByWabaId(wabaId);
    return configs[0]?.companyId ?? null;
  }
}

function mapWebhookEventToStatus(field: string, event?: string): string {
  const ev = (event ?? field).toUpperCase();
  if (ev.includes('APPROVE')) {
    return 'APPROVED';
  }
  if (ev.includes('REJECT')) {
    return 'REJECTED';
  }
  if (ev.includes('PAUSE') || ev.includes('DISABLE')) {
    return 'PAUSED';
  }
  if (ev.includes('PENDING')) {
    return 'PENDING';
  }
  return ev;
}
