import { Injectable, Logger } from '@nestjs/common';

import { WhatsAppContactService } from './whatsapp-contact.service';

const OPT_OUT_PATTERNS = [
  /^stop$/i,
  /^unsubscribe$/i,
  /^cancel$/i,
  /^opt[\s-]?out$/i,
  /^end$/i,
  /^quit$/i,
];

@Injectable()
export class WhatsAppOptOutService {
  private readonly logger = new Logger(WhatsAppOptOutService.name);

  constructor(private readonly contactService: WhatsAppContactService) {}

  isOptOutMessage(text: string | undefined): boolean {
    if (!text?.trim()) {
      return false;
    }
    const normalized = text.trim();
    return OPT_OUT_PATTERNS.some(p => p.test(normalized));
  }

  async handleOptOut(companyId: string, phone: string): Promise<void> {
    await this.contactService.markUnsubscribedByPhone(companyId, phone);
    this.logger.log(`Contact ${phone} unsubscribed for company ${companyId}`);
  }
}
