import type { WhatsAppConversation } from '../../models/whatsapp/whatsapp-conversation.entity';

type WindowFields = Pick<WhatsAppConversation, 'serviceWindowExpiresAt' | 'lastInboundAt'>;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether free-form session messages (text/media) are allowed for this conversation.
 * Requires a customer inbound within the configured window (default 24h).
 */
export function isFreeformSessionOpen(
  conversation: WindowFields,
  nowMs: number = Date.now(),
  windowMs: number = DEFAULT_WINDOW_MS,
): boolean {
  if (conversation.serviceWindowExpiresAt) {
    return conversation.serviceWindowExpiresAt.getTime() > nowMs;
  }
  if (conversation.lastInboundAt) {
    return conversation.lastInboundAt.getTime() + windowMs > nowMs;
  }
  return false;
}

export function requiresTemplateForFreeform(
  conversation: WindowFields,
  nowMs?: number,
  windowMs?: number,
): boolean {
  return !isFreeformSessionOpen(conversation, nowMs, windowMs);
}
