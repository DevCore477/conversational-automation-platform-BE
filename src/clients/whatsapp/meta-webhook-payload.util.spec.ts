import {
  extractPhoneNumberIdsFromWebhook,
  extractStatusEventsFromWebhook,
} from './meta-webhook-payload.util';

describe('meta-webhook-payload.util', () => {
  const sampleBody = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '123456789' },
              statuses: [
                {
                  id: 'wamid.ABC123',
                  status: 'delivered',
                  timestamp: '1710000000',
                  recipient_id: '15551234567',
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it('extracts phone number ids', () => {
    expect(extractPhoneNumberIdsFromWebhook(sampleBody)).toEqual(['123456789']);
  });

  it('extracts status events', () => {
    const events = extractStatusEventsFromWebhook(sampleBody);
    expect(events).toHaveLength(1);
    expect(events[0].phoneNumberId).toBe('123456789');
    expect(events[0].status.id).toBe('wamid.ABC123');
    expect(events[0].status.status).toBe('delivered');
  });
});
