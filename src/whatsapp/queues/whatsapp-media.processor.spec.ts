import { WhatsAppJobType, WhatsAppMediaKind, WhatsAppMediaProcessingStatus } from '../../common/enums/whatsapp.enum';
import { WhatsAppMediaProcessor } from './whatsapp-media.processor';

describe('WhatsAppMediaProcessor', () => {
  const mediaRowId = 'media-row-1';
  const baseJobData = {
    mediaRowId,
    messageId: 'message-1',
    conversationId: 'conversation-1',
    companyId: 'company-1',
    metaPhoneNumberId: 'phone-number-id',
    inboundWamid: 'wamid-1',
    userText: '',
  };

  let configService: { get: jest.Mock };
  let mediaRepo: { findOne: jest.Mock; update: jest.Mock };
  let waConfigService: { getActiveConfigOrThrow: jest.Mock; createMetaClient: jest.Mock };
  let s3Service: { uploadMedia: jest.Mock };
  let visionService: { analyzeImage: jest.Mock; mergeFrameAnalyses: jest.Mock };
  let audioService: { transcribe: jest.Mock };
  let documentService: { isSupported: jest.Mock; extract: jest.Mock };
  let videoService: { process: jest.Mock };
  let openaiClient: { createEmbedding: jest.Mock };
  let queueService: { enqueue: jest.Mock };
  let processor: WhatsAppMediaProcessor;
  let metaClient: { downloadInboundMedia: jest.Mock };

  beforeEach(() => {
    configService = { get: jest.fn().mockReturnValue({ mediaMaxVideoDurationSeconds: 180, mediaMaxDocumentBytes: 25_000_000 }) };
    mediaRepo = {
      findOne: jest.fn().mockResolvedValue({ id: mediaRowId }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    metaClient = { downloadInboundMedia: jest.fn() };
    waConfigService = {
      getActiveConfigOrThrow: jest.fn().mockResolvedValue({}),
      createMetaClient: jest.fn().mockReturnValue(metaClient),
    };
    s3Service = { uploadMedia: jest.fn().mockResolvedValue({ fileUrl: 'https://cdn/img.jpg', key: 'k' }) };
    visionService = {
      analyzeImage: jest.fn().mockResolvedValue({
        description: 'a photo',
        ocrText: '',
        objects: ['object'],
        entities: [],
        summary: 'summary',
      }),
      mergeFrameAnalyses: jest.fn(),
    };
    audioService = { transcribe: jest.fn().mockResolvedValue('transcribed text') };
    documentService = { isSupported: jest.fn().mockReturnValue(true), extract: jest.fn() };
    videoService = { process: jest.fn() };
    openaiClient = { createEmbedding: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2], model: 'text-embedding-3-small' }) };
    queueService = { enqueue: jest.fn().mockResolvedValue(undefined) };

    processor = new WhatsAppMediaProcessor(
      configService as never,
      mediaRepo as never,
      waConfigService as never,
      s3Service as never,
      visionService as never,
      audioService as never,
      documentService as never,
      videoService as never,
      openaiClient as never,
      queueService as never,
    );
  });

  function runProcess(data: Record<string, unknown>) {
    return (processor as unknown as { process: (job: { data: unknown }) => Promise<void> }).process({
      data,
    });
  }

  it('marks an image row completed and always enqueues INBOUND_REPLY', async () => {
    metaClient.downloadInboundMedia.mockResolvedValue({
      buffer: Buffer.from('fake-image'),
      mimeType: 'image/jpeg',
      filename: 'image.jpg',
      sha256: 'abc',
    });

    await runProcess({ ...baseJobData, mediaType: WhatsAppMediaKind.IMAGE, metaMediaId: 'meta-1' });

    const updateCalls = mediaRepo.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][1];
    expect(finalUpdate.status).toBe(WhatsAppMediaProcessingStatus.COMPLETED);
    expect(finalUpdate.visionDescription).toBe('a photo');

    expect(queueService.enqueue).toHaveBeenCalledTimes(1);
    expect(queueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: WhatsAppJobType.INBOUND_REPLY, conversationId: 'conversation-1' }),
    );
  });

  it('marks the row failed and still enqueues INBOUND_REPLY when download fails', async () => {
    metaClient.downloadInboundMedia.mockRejectedValue(new Error('media url expired'));

    await runProcess({ ...baseJobData, mediaType: WhatsAppMediaKind.IMAGE, metaMediaId: 'meta-1' });

    const updateCalls = mediaRepo.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][1];
    expect(finalUpdate.status).toBe(WhatsAppMediaProcessingStatus.FAILED);
    expect(finalUpdate.errorMessage).toContain('media url expired');

    expect(queueService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('marks unsupported documents without throwing, and still enqueues INBOUND_REPLY', async () => {
    metaClient.downloadInboundMedia.mockResolvedValue({
      buffer: Buffer.from('fake-doc'),
      mimeType: 'application/zip',
      filename: 'archive.zip',
    });
    documentService.isSupported.mockReturnValue(false);

    await runProcess({ ...baseJobData, mediaType: WhatsAppMediaKind.DOCUMENT, metaMediaId: 'meta-2', filename: 'archive.zip' });

    const updateCalls = mediaRepo.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][1];
    expect(finalUpdate.status).toBe(WhatsAppMediaProcessingStatus.UNSUPPORTED);
    expect(queueService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('processes location messages from inline structured data with no download', async () => {
    await runProcess({
      ...baseJobData,
      mediaType: WhatsAppMediaKind.LOCATION,
      structuredData: { location: { latitude: 1, longitude: 2, name: 'HQ' } },
    });

    expect(metaClient.downloadInboundMedia).not.toHaveBeenCalled();
    const updateCalls = mediaRepo.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][1];
    expect(finalUpdate.status).toBe(WhatsAppMediaProcessingStatus.COMPLETED);
    expect(finalUpdate.sceneSummary).toContain('HQ');
    expect(queueService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the media row no longer exists', async () => {
    mediaRepo.findOne.mockResolvedValue(null);

    await runProcess({ ...baseJobData, mediaType: WhatsAppMediaKind.IMAGE, metaMediaId: 'meta-1' });

    expect(mediaRepo.update).not.toHaveBeenCalled();
    expect(queueService.enqueue).not.toHaveBeenCalled();
  });
});
