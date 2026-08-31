import { MetaWhatsAppClient } from '../../clients/whatsapp/meta-whatsapp.client';
import { StaticWhatsAppTokenProvider } from '../../clients/whatsapp/whatsapp-token-provider';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor';

/**
 * Regression coverage for a real production incident: replies/mark-read calls used the single
 * globally-injected WHATSAPP_CLIENT (bound to whatever WHATSAPP_META_PHONE_NUMBER_ID is set at
 * boot) instead of the conversation's own company's configured number. In a multi-tenant deployment
 * this silently sends from the wrong WhatsApp Business number — the customer never sees the reply,
 * and Meta's "24h re-engagement window" error is a red herring (true for the wrong number, not the
 * one the customer actually messaged).
 */
describe('WhatsAppQueueProcessor — per-company client resolution', () => {
  let companyClient: MetaWhatsAppClient;
  let globalClient: MetaWhatsAppClient;
  let queueService: Record<string, jest.Mock>;
  let chatService: Record<string, jest.Mock>;
  let waConfigService: { getActiveConfigOrThrow: jest.Mock; createMetaClient: jest.Mock };
  let processor: WhatsAppQueueProcessor;

  beforeEach(() => {
    companyClient = new MetaWhatsAppClient(
      new StaticWhatsAppTokenProvider('company-token'),
      'company-phone-id',
      'v25.0',
      '+10000000000',
      'en',
    );
    globalClient = new MetaWhatsAppClient(
      new StaticWhatsAppTokenProvider('global-token'),
      'global-fallback-phone-id',
      'v25.0',
      '+19999999999',
      'en',
    );

    jest.spyOn(companyClient, 'markMessageAsRead').mockResolvedValue(undefined);
    jest.spyOn(companyClient, 'sendText').mockResolvedValue({
      messageSid: 'wamid-company',
      status: 'accepted',
      to: '+15551234567',
      from: '+10000000000',
    });
    jest.spyOn(globalClient, 'markMessageAsRead').mockResolvedValue(undefined);
    jest.spyOn(globalClient, 'sendText').mockResolvedValue({
      messageSid: 'wamid-global',
      status: 'accepted',
      to: '+15551234567',
      from: '+19999999999',
    });

    queueService = {};
    chatService = {
      createOutboundPending: jest.fn().mockResolvedValue({ id: 'pending-1' }),
      attachOutboundWamid: jest.fn().mockResolvedValue(undefined),
      markInboundReadByWamid: jest.fn().mockResolvedValue(undefined),
    };
    waConfigService = {
      getActiveConfigOrThrow: jest.fn().mockResolvedValue({ id: 'config-1' }),
      createMetaClient: jest.fn().mockReturnValue(companyClient),
    };

    processor = new WhatsAppQueueProcessor(
      queueService as never,
      chatService as never,
      {} as never, // messageLog
      {} as never, // inboundConfig
      {} as never, // conversationEngine
      {} as never, // messageBuilder
      globalClient as never,
      {} as never, // configService
      {} as never, // campaignRepo
      {} as never, // templateService
      waConfigService as never,
    );
  });

  function call<T>(method: string, ...args: unknown[]): Promise<T> {
    return (processor as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method](...args);
  }

  it('marks read using the company-specific client, not the global fallback', async () => {
    await call('processMarkRead', { payload: { metaWamid: 'wamid-1', companyId: 'company-1' } });

    expect(waConfigService.getActiveConfigOrThrow).toHaveBeenCalledWith('company-1');
    expect(companyClient.markMessageAsRead).toHaveBeenCalledWith('wamid-1');
    expect(globalClient.markMessageAsRead).not.toHaveBeenCalled();
  });

  it('sends the reply using the company-specific client, not the global fallback', async () => {
    await call('sendTextReply', 'conversation-1', '+15551234567', 'hello', 'company-1');

    expect(companyClient.sendText).toHaveBeenCalledWith({ to: '+15551234567', body: 'hello' });
    expect(globalClient.sendText).not.toHaveBeenCalled();
    expect(chatService.attachOutboundWamid).toHaveBeenCalledWith('pending-1', 'wamid-company');
  });

  it('falls back to the global client when no companyId is available', async () => {
    await call('sendTextReply', 'conversation-1', '+15551234567', 'hello', undefined);

    expect(waConfigService.getActiveConfigOrThrow).not.toHaveBeenCalled();
    expect(globalClient.sendText).toHaveBeenCalledWith({ to: '+15551234567', body: 'hello' });
  });

  it('falls back to the global client when the company has no active WhatsApp config', async () => {
    waConfigService.getActiveConfigOrThrow.mockRejectedValue(new Error('no config'));

    await call('sendTextReply', 'conversation-1', '+15551234567', 'hello', 'company-without-config');

    expect(globalClient.sendText).toHaveBeenCalledWith({ to: '+15551234567', body: 'hello' });
    expect(companyClient.sendText).not.toHaveBeenCalled();
  });
});
