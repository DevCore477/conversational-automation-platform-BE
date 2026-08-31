import type { WhatsAppMediaKind } from '../../common/enums/whatsapp.enum';
import type { WhatsAppMediaStructuredData } from '../../models/whatsapp/whatsapp-message-media.entity';

export const WHATSAPP_MEDIA_QUEUE = 'whatsapp-media';

export interface WhatsAppMediaJobPayload {
  mediaRowId: string;
  messageId: string;
  conversationId: string;
  companyId: string;
  mediaType: WhatsAppMediaKind;
  /** Meta media id — absent for location/contact, which arrive inline in the webhook. */
  metaMediaId?: string;
  mimeType?: string;
  filename?: string;
  caption?: string;
  isVoiceNote?: boolean;
  structuredData?: WhatsAppMediaStructuredData;
  /** Carried through so the processor can enqueue INBOUND_REPLY once media handling is done. */
  metaPhoneNumberId: string;
  inboundWamid: string;
  userText: string;
}
