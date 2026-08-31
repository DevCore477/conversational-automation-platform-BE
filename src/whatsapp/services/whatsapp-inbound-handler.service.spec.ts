import { WhatsAppJobType, WhatsAppMediaKind } from '../../common/enums/whatsapp.enum';
import { WhatsAppInboundHandlerService } from './whatsapp-inbound-handler.service';

describe('WhatsAppInboundHandlerService', () => {
  const companyId = 'company-1';
  const contactPhone = '+15551234567';
  const conversationId = 'conversation-1';
  const messageId = 'message-1';

  let chatService: { saveInboundMessage: jest.Mock };
  let inboundConfig: { resolve: jest.Mock };
  let companyConfig: { getByPhoneNumberId: jest.Mock };
  let contactService: { findOrCreateByPhone: jest.Mock };
  let conversationService: { findOrCreate: jest.Mock; extendServiceWindow: jest.Mock };
  let optOutService: { isOptOutMessage: jest.Mock; handleOptOut: jest.Mock };
  let messageLog: Record<string, jest.Mock>;
  let queueService: { enqueue: jest.Mock };
  let mediaQueueService: { enqueue: jest.Mock };
  let mediaRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let service: WhatsAppInboundHandlerService;

  beforeEach(() => {
    chatService = {
      saveInboundMessage: jest.fn().mockResolvedValue({ id: messageId }),
    };
    inboundConfig = {
      resolve: jest.fn().mockResolvedValue({ companyId, markInboundAsRead: false }),
    };
    companyConfig = {
      getByPhoneNumberId: jest.fn().mockResolvedValue({ companyId }),
    };
    contactService = {
      findOrCreateByPhone: jest.fn().mockResolvedValue({ id: 'contact-1' }),
    };
    conversationService = {
      findOrCreate: jest.fn().mockResolvedValue({ id: conversationId }),
      extendServiceWindow: jest.fn().mockResolvedValue(undefined),
    };
    optOutService = {
      isOptOutMessage: jest.fn().mockReturnValue(false),
      handleOptOut: jest.fn(),
    };
    messageLog = {};
    queueService = { enqueue: jest.fn().mockResolvedValue(undefined) };
    mediaQueueService = { enqueue: jest.fn().mockResolvedValue(undefined) };
    mediaRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(row => row),
      save: jest.fn().mockResolvedValue({ id: 'media-row-1' }),
    };

    service = new WhatsAppInboundHandlerService(
      chatService as never,
      inboundConfig as never,
      companyConfig as never,
      contactService as never,
      conversationService as never,
      optOutService as never,
      messageLog as never,
      queueService as never,
      mediaQueueService as never,
      mediaRepo as never,
      null,
    );
  });

  it('enqueues INBOUND_REPLY directly for plain text messages, without touching the media pipeline', async () => {
    await service.handleInboundMessage('phone-number-id', {
      from: contactPhone,
      id: 'wamid-1',
      type: 'text',
      text: { body: 'hello there' },
    });

    expect(mediaRepo.save).not.toHaveBeenCalled();
    expect(mediaQueueService.enqueue).not.toHaveBeenCalled();
    expect(queueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: WhatsAppJobType.INBOUND_REPLY,
        conversationId,
        payload: expect.objectContaining({ userText: 'hello there' }),
      }),
    );
  });

  it('routes image messages to the media pipeline instead of enqueueing INBOUND_REPLY directly', async () => {
    await service.handleInboundMessage('phone-number-id', {
      from: contactPhone,
      id: 'wamid-2',
      type: 'image',
      image: { id: 'meta-media-1', mime_type: 'image/jpeg', caption: 'check this out' },
    });

    expect(mediaRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ messageId, conversationId, mediaType: WhatsAppMediaKind.IMAGE }),
    );
    expect(mediaQueueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaRowId: 'media-row-1',
        messageId,
        conversationId,
        companyId,
        mediaType: WhatsAppMediaKind.IMAGE,
        metaMediaId: 'meta-media-1',
        mimeType: 'image/jpeg',
        caption: 'check this out',
        userText: 'check this out',
      }),
    );
    expect(queueService.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobType: WhatsAppJobType.INBOUND_REPLY }),
    );
  });

  it('skips re-enqueueing media when the message was already tracked (webhook retry)', async () => {
    mediaRepo.findOne.mockResolvedValue({ id: 'existing-media-row' });

    await service.handleInboundMessage('phone-number-id', {
      from: contactPhone,
      id: 'wamid-3',
      type: 'document',
      document: { id: 'meta-media-2', mime_type: 'application/pdf', filename: 'invoice.pdf' },
    });

    expect(mediaRepo.save).not.toHaveBeenCalled();
    expect(mediaQueueService.enqueue).not.toHaveBeenCalled();
  });

  it('routes location messages to the media pipeline with structured data, no metaMediaId required', async () => {
    await service.handleInboundMessage('phone-number-id', {
      from: contactPhone,
      id: 'wamid-4',
      type: 'location',
      location: { latitude: 1.23, longitude: 4.56, name: 'HQ' },
    });

    expect(mediaQueueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaType: WhatsAppMediaKind.LOCATION,
        metaMediaId: undefined,
        structuredData: { location: { latitude: 1.23, longitude: 4.56, name: 'HQ' } },
      }),
    );
  });
});
