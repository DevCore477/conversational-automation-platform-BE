export type WhatsAppOutboundMessageType = 'template' | 'text';

export interface WhatsAppOutboundJobPayload {
  companyId: string;
  contactId: string;
  campaignId?: string;
  conversationId?: string;
  phoneNumber: string;
  messageType: WhatsAppOutboundMessageType;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: string[];
  templateContentVariables?: Record<string, string>;
  templateComponents?: Record<string, unknown>[] | null;
  templateBodyPreview?: string | null;
  messageBody?: string;
  messageLogId: string;
  priority?: number;
}

export const WHATSAPP_OUTBOUND_QUEUE = 'whatsapp-outbound';
