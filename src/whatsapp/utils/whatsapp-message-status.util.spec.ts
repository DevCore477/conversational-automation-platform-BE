import { WhatsAppMessageDirection, WhatsAppMessageStatus } from '../../common/enums/whatsapp.enum';
import {
  mapMetaWebhookStatus,
  shouldApplyStatusUpdate,
} from './whatsapp-message-status.util';

describe('whatsapp-message-status.util', () => {
  it('maps Meta webhook statuses', () => {
    expect(mapMetaWebhookStatus('sent')).toBe(WhatsAppMessageStatus.SENT);
    expect(mapMetaWebhookStatus('delivered')).toBe(WhatsAppMessageStatus.DELIVERED);
    expect(mapMetaWebhookStatus('read')).toBe(WhatsAppMessageStatus.READ);
    expect(mapMetaWebhookStatus('failed')).toBe(WhatsAppMessageStatus.FAILED);
  });

  it('allows outbound progression accepted → sent → delivered → read', () => {
    expect(
      shouldApplyStatusUpdate(
        WhatsAppMessageStatus.ACCEPTED,
        WhatsAppMessageStatus.SENT,
        WhatsAppMessageDirection.OUTBOUND,
      ),
    ).toBe(true);
    expect(
      shouldApplyStatusUpdate(
        WhatsAppMessageStatus.SENT,
        WhatsAppMessageStatus.DELIVERED,
        WhatsAppMessageDirection.OUTBOUND,
      ),
    ).toBe(true);
    expect(
      shouldApplyStatusUpdate(
        WhatsAppMessageStatus.DELIVERED,
        WhatsAppMessageStatus.READ,
        WhatsAppMessageDirection.OUTBOUND,
      ),
    ).toBe(true);
  });

  it('blocks regressive outbound status (sent → accepted)', () => {
    expect(
      shouldApplyStatusUpdate(
        WhatsAppMessageStatus.SENT,
        WhatsAppMessageStatus.ACCEPTED,
        WhatsAppMessageDirection.OUTBOUND,
      ),
    ).toBe(false);
  });

  it('always allows failed', () => {
    expect(
      shouldApplyStatusUpdate(
        WhatsAppMessageStatus.DELIVERED,
        WhatsAppMessageStatus.FAILED,
        WhatsAppMessageDirection.OUTBOUND,
      ),
    ).toBe(true);
  });
});
