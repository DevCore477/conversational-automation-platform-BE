import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { MetaWhatsAppClient } from '../clients/whatsapp/meta-whatsapp.client';
import {
  WHATSAPP_CLIENT,
  type WhatsAppClientLike,
} from '../clients/whatsapp/whatsapp.provider';
import type { WhatsAppSendResult } from '../clients/whatsapp/whatsapp.types';
import { normalizePhoneNumber } from '../common/utils/phone.util';
import type { WhatsAppMessageDesign } from './types/message-design.types';
import { WhatsAppMessageDesignSchema } from './types/message-design.types';
import {
  applyVariablesToDesign,
  buildMetaPayload,
  designPreviewText,
} from './utils/message-builder.util';

export interface MessageDesignPreview {
  design: WhatsAppMessageDesign;
  preview: string;
  payload: Record<string, unknown>;
  recipientExample?: string;
}

@Injectable()
export class WhatsAppMessageBuilderService {
  constructor(@Inject(WHATSAPP_CLIENT) private readonly client: WhatsAppClientLike | null) {}

  parseDesign(input: unknown): WhatsAppMessageDesign {
    const parsed = WhatsAppMessageDesignSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return parsed.data;
  }

  preview(
    designInput: unknown,
    variables?: Record<string, string>,
    examplePhone?: string,
  ): MessageDesignPreview {
    const design = applyVariablesToDesign(this.parseDesign(designInput), variables);
    const digits = examplePhone
      ? normalizePhoneNumber(examplePhone).replace(/^\+/, '')
      : '0000000000';

    return {
      design,
      preview: designPreviewText(design),
      payload: buildMetaPayload(design, digits),
      recipientExample: examplePhone,
    };
  }

  async sendDesigned(
    designInput: unknown,
    to: string,
    variables?: Record<string, string>,
    clientOverride?: WhatsAppClientLike | null,
  ): Promise<WhatsAppSendResult & { preview: string }> {
    const client = clientOverride ?? this.client;
    if (!client) {
      throw new BadRequestException('WhatsApp is not configured');
    }

    const normalized = normalizePhoneNumber(to);
    if (!normalized) {
      throw new BadRequestException('Invalid recipient phone number');
    }

    const design = applyVariablesToDesign(this.parseDesign(designInput), variables);
    const digits = normalized.replace(/^\+/, '');
    const payload = buildMetaPayload(design, digits);
    const preview = designPreviewText(design);

    if (
      (design.type === 'interactive_buttons' || design.type === 'interactive_list') &&
      !(client instanceof MetaWhatsAppClient)
    ) {
      throw new BadRequestException(
        'Interactive buttons/lists require Meta WhatsApp (WHATSAPP_PROVIDER=meta)',
      );
    }

    const result = await client.sendPayload(payload);
    return { ...result, preview };
  }
}
