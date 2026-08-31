import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { normalizePhoneNumber } from '../../common/utils/phone.util';
import { WhatsAppContact } from '../../models/whatsapp/whatsapp-contact.entity';

export interface ContactSendEligibility {
  contact: WhatsAppContact;
  eligible: boolean;
  skipReason?: string;
}

@Injectable()
export class WhatsAppContactService {
  constructor(
    @InjectRepository(WhatsAppContact)
    private readonly contactRepo: Repository<WhatsAppContact>,
  ) {}

  normalizePhone(phone: string): string {
    const normalized = normalizePhoneNumber(phone);
    if (!normalized) {
      throw new BadRequestException(`Invalid phone number: ${phone}`);
    }
    return normalized;
  }

  async findById(companyId: string, contactId: string): Promise<WhatsAppContact | null> {
    return this.contactRepo.findOne({ where: { id: contactId, companyId } });
  }

  async findByIds(companyId: string, contactIds: string[]): Promise<WhatsAppContact[]> {
    if (contactIds.length === 0) {
      return [];
    }
    return this.contactRepo.find({ where: { id: In(contactIds), companyId } });
  }

  async findOrCreateByPhone(
    companyId: string,
    phone: string,
    name?: string,
    opts?: { optIn?: boolean; optInSource?: string },
  ): Promise<WhatsAppContact> {
    const phoneNumber = this.normalizePhone(phone);
    let contact = await this.contactRepo.findOne({ where: { companyId, phoneNumber } });
    if (!contact) {
      contact = await this.contactRepo.save(
        this.contactRepo.create({
          companyId,
          phoneNumber,
          name: name ?? null,
          whatsappOptIn: opts?.optIn === true,
          whatsappOptInSource: opts?.optIn ? (opts.optInSource ?? 'import') : null,
          whatsappOptInAt: opts?.optIn ? new Date() : null,
        }),
      );
      return contact;
    }

    let dirty = false;
    if (name && !contact.name) {
      contact.name = name;
      dirty = true;
    }
    if (opts?.optIn && !contact.whatsappOptIn) {
      contact.whatsappOptIn = true;
      contact.whatsappOptInSource = opts.optInSource ?? 'import';
      contact.whatsappOptInAt = new Date();
      contact.whatsappUnsubscribed = false;
      dirty = true;
    }
    if (dirty) {
      contact = await this.contactRepo.save(contact);
    }
    return contact;
  }

  /**
   * Resolve external phone numbers to company-scoped whatsapp_contacts (create if missing).
   */
  async resolveCampaignRecipients(
    companyId: string,
    inputs: { phone: string; name?: string }[],
    opts: { optInOnImport: boolean },
  ): Promise<WhatsAppContact[]> {
    const seen = new Set<string>();
    const contacts: WhatsAppContact[] = [];

    for (const row of inputs) {
      const phoneNumber = this.normalizePhone(row.phone);
      if (seen.has(phoneNumber)) {
        continue;
      }
      seen.add(phoneNumber);

      const contact = await this.findOrCreateByPhone(companyId, phoneNumber, row.name, {
        optIn: opts.optInOnImport,
        optInSource: 'campaign_import',
      });
      contacts.push(contact);
    }

    return contacts;
  }

  checkEligibility(contact: WhatsAppContact): ContactSendEligibility {
    if (!contact.whatsappOptIn) {
      return { contact, eligible: false, skipReason: 'no_opt_in' };
    }
    if (contact.whatsappUnsubscribed) {
      return { contact, eligible: false, skipReason: 'unsubscribed' };
    }
    if (contact.whatsappBlocked) {
      return { contact, eligible: false, skipReason: 'blocked' };
    }
    return { contact, eligible: true };
  }

  async markUnsubscribed(companyId: string, contactId: string): Promise<void> {
    await this.contactRepo.update(
      { id: contactId, companyId },
      { whatsappUnsubscribed: true },
    );
  }

  async markUnsubscribedByPhone(companyId: string, phone: string): Promise<void> {
    const phoneNumber = this.normalizePhone(phone);
    await this.contactRepo.update({ companyId, phoneNumber }, { whatsappUnsubscribed: true });
  }

  async markBlocked(companyId: string, contactId: string): Promise<void> {
    await this.contactRepo.update({ id: contactId, companyId }, { whatsappBlocked: true });
  }

  async recordOptIn(
    companyId: string,
    contactId: string,
    source: string,
  ): Promise<void> {
    await this.contactRepo.update(
      { id: contactId, companyId },
      {
        whatsappOptIn: true,
        whatsappOptInSource: source,
        whatsappOptInAt: new Date(),
        whatsappUnsubscribed: false,
      },
    );
  }
}
