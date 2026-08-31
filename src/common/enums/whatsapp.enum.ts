export enum WhatsAppMessageDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

/** Mirrors Meta webhook statuses: sent → delivered → read (blue ticks). */
export enum WhatsAppMessageStatus {
  RECEIVED = 'received',
  PENDING = 'pending',
  QUEUED = 'queued',
  /** Meta Graph API accepted the send; not yet confirmed via webhook `sent`. */
  ACCEPTED = 'accepted',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

export enum WhatsAppJobType {
  INBOUND_REPLY = 'inbound_reply',
  OUTBOUND_SEND = 'outbound_send',
  BULK_SEND = 'bulk_send',
  MARK_READ = 'mark_read',
}

/** Kind of media/structured content attached to an inbound WhatsApp message. */
export enum WhatsAppMediaKind {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  STICKER = 'sticker',
  LOCATION = 'location',
  CONTACT = 'contact',
}

/** Lifecycle of the async media-understanding pipeline (download → analyze → embed). */
export enum WhatsAppMediaProcessingStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  UNSUPPORTED = 'unsupported',
}

export enum WhatsAppJobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum WhatsAppRoutingMode {
  AGENT = 'agent',
  FLOW = 'flow',
  SCRIPT = 'script',
  AI = 'ai',
  DATABASE_DEFAULT = 'database_default',
}

export enum WhatsAppCampaignStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  SENDING = 'sending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  PAUSED = 'paused',
  CANCELLED = 'cancelled',
}

export enum WhatsAppConversationStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  HUMAN_HANDOFF = 'human_handoff',
}

/** Mirrors Meta template review states (stored lowercase in DB). */
export enum WhatsAppTemplateStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PAUSED = 'paused',
  DISABLED = 'disabled',
}

export const WHATSAPP_TEMPLATE_USABLE_STATUSES = new Set<string>([
  WhatsAppTemplateStatus.APPROVED,
]);

/** How a company template row was created. */
export enum WhatsAppTemplateSource {
  CUSTOM = 'custom',
  META_LIBRARY = 'meta_library',
  SYNCED = 'synced',
}

export const WHATSAPP_TEMPLATE_CATEGORIES = [
  'UTILITY',
  'MARKETING',
  'AUTHENTICATION',
] as const;

/** Meta errors that should not be retried indefinitely */
export const WHATSAPP_PERMANENT_ERROR_CODES = new Set([
  131026, // blocked by user
  131047, // re-engagement / outside window
  131051, // unsupported message type
  133010,
  100, // invalid parameter
  131030, // invalid recipient
  132000, // template params don't match
]);
