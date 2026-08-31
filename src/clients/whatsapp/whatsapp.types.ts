export type WhatsAppMessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'undelivered'
  | 'canceled'
  | string;

export interface SendWhatsAppTextParams {
  to: string;
  body: string;
}

export type WhatsAppMediaType = 'image' | 'video' | 'document' | 'audio';

export interface SendWhatsAppMediaParams {
  to: string;
  body?: string;
  mediaUrl: string[];
  /** Override auto-detection from URL extension */
  mediaType?: WhatsAppMediaType;
  /**
   * When true (default for audio/video/document), upload via Meta Media API first.
   * Prevents error 131053 when Meta cannot fetch CDN URLs directly.
   */
  uploadViaMediaApi?: boolean;
}

export interface TemplateSendComponentPayload {
  type: 'header' | 'body' | 'button' | string;
  sub_type?: string;
  index?: string | number;
  parameters?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
}

export interface SendWhatsAppTemplateParams {
  to: string;
  /** Meta: approved template name. Twilio: Content SID. */
  contentSid: string;
  /** Meta: same as template name when using Meta provider */
  templateName?: string;
  contentVariables?: Record<string, string>;
  /** Ordered body placeholders (preferred for Meta {{1}}, {{2}}, …) */
  parameters?: string[];
  /** Header/body/button components (Meta Cloud API send format). */
  components?: TemplateSendComponentPayload[];
  /** Synced template components — enables named {{var}} resolution when sending. */
  templateComponents?: Record<string, unknown>[] | null;
  /** ISO language code, e.g. en, en_US, ar */
  languageCode?: string;
}

export interface WhatsAppSendResult {
  messageSid: string;
  status: WhatsAppMessageStatus;
  to: string;
  from: string;
}

/** Runtime-designed message payload (Meta Cloud API). */
export interface SendWhatsAppDesignedParams {
  to: string;
  payload: Record<string, unknown>;
}
