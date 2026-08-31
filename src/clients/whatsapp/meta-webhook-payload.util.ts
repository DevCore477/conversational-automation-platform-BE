/**
 * Helpers for parsing Meta WhatsApp webhook JSON (signature verification + routing).
 */

export interface MetaWebhookStatusEvent {
  phoneNumberId: string;
  status: {
    id: string;
    status: string;
    timestamp?: string;
    recipient_id?: string;
    errors?: { code?: number; title?: string; message?: string }[];
  };
  field: string;
}

export function extractPhoneNumberIdsFromWebhook(body: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const entries = body.entry;
  if (!Array.isArray(entries)) {
    return [];
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const change of changes) {
      if (!change || typeof change !== 'object') {
        continue;
      }
      const value = (change as { value?: { metadata?: { phone_number_id?: string } } }).value;
      const phoneNumberId = value?.metadata?.phone_number_id?.trim();
      if (phoneNumberId) {
        ids.add(phoneNumberId);
      }
    }
  }

  return [...ids];
}

export function extractStatusEventsFromWebhook(
  body: Record<string, unknown>,
): MetaWebhookStatusEvent[] {
  const events: MetaWebhookStatusEvent[] = [];
  const entries = body.entry;
  if (!Array.isArray(entries)) {
    return events;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const change of changes) {
      if (!change || typeof change !== 'object') {
        continue;
      }
      const field = String((change as { field?: string }).field ?? '');
      const value = (change as {
        value?: {
          metadata?: { phone_number_id?: string };
          statuses?: MetaWebhookStatusEvent['status'][];
        };
      }).value;
      const phoneNumberId = value?.metadata?.phone_number_id?.trim() ?? '';
      const statuses = value?.statuses;
      if (!phoneNumberId || !Array.isArray(statuses)) {
        continue;
      }
      for (const status of statuses) {
        if (status?.id && status?.status) {
          events.push({ phoneNumberId, status, field });
        }
      }
    }
  }

  return events;
}
