import { WhatsAppMessageStatus } from '../../common/enums/whatsapp.enum';

/** Delivery progression for outbound messages (higher = further along). */
const OUTBOUND_STATUS_RANK: Record<string, number> = {
  [WhatsAppMessageStatus.PENDING]: 0,
  [WhatsAppMessageStatus.QUEUED]: 1,
  [WhatsAppMessageStatus.ACCEPTED]: 2,
  [WhatsAppMessageStatus.SENT]: 3,
  [WhatsAppMessageStatus.DELIVERED]: 4,
  [WhatsAppMessageStatus.READ]: 5,
  [WhatsAppMessageStatus.FAILED]: 100,
};

const INBOUND_STATUS_RANK: Record<string, number> = {
  [WhatsAppMessageStatus.RECEIVED]: 0,
  [WhatsAppMessageStatus.SENT]: 1,
  [WhatsAppMessageStatus.DELIVERED]: 2,
  [WhatsAppMessageStatus.READ]: 3,
  [WhatsAppMessageStatus.FAILED]: 100,
};

export function mapMetaWebhookStatus(metaStatus: string): WhatsAppMessageStatus {
  switch (metaStatus?.toLowerCase()) {
    case 'sent':
      return WhatsAppMessageStatus.SENT;
    case 'delivered':
      return WhatsAppMessageStatus.DELIVERED;
    case 'read':
      return WhatsAppMessageStatus.READ;
    case 'failed':
      return WhatsAppMessageStatus.FAILED;
    default:
      return WhatsAppMessageStatus.QUEUED;
  }
}

/**
 * Meta webhook statuses should only move forward (except failed always applies).
 */
export function shouldApplyStatusUpdate(
  currentStatus: string,
  nextStatus: WhatsAppMessageStatus,
  direction: 'inbound' | 'outbound',
): boolean {
  if (nextStatus === WhatsAppMessageStatus.FAILED) {
    return true;
  }

  const rankMap = direction === 'outbound' ? OUTBOUND_STATUS_RANK : INBOUND_STATUS_RANK;
  const currentRank = rankMap[currentStatus] ?? -1;
  const nextRank = rankMap[nextStatus] ?? -1;
  return nextRank > currentRank;
}

export function normalizeMetaWamid(wamid: string | null | undefined): string | null {
  const trimmed = wamid?.trim();
  return trimmed?.length ? trimmed : null;
}
