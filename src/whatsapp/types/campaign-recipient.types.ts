/** External WhatsApp recipient — not required to be a Hexa AI user. */
export interface CampaignRecipientInput {
  phone: string;
  name?: string;
  /** Template body variable values in order (param1, param2, …) */
  templateParams?: string[];
  variables?: Record<string, string>;
}

export interface ResolvedCampaignRecipient {
  phone: string;
  contactId: string;
  contact: import('../../models/whatsapp/whatsapp-contact.entity').WhatsAppContact;
  templateParams?: string[];
}
