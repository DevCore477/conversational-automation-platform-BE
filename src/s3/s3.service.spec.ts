const sendMock = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: jest.fn().mockImplementation(input => ({ input })),
  DeleteObjectCommand: jest.fn().mockImplementation(input => ({ input })),
}));

import { S3Service } from './s3.service';

describe('S3Service.uploadMedia — bucket override', () => {
  let configService: { get: jest.Mock };
  let service: S3Service;

  beforeEach(() => {
    sendMock.mockClear();
    configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          's3.region': 'ap-south-1',
          's3.accessKeyId': 'key',
          's3.secretAccessKey': 'secret',
          's3.bucketName': 'hexa-ai-bucket',
          's3.prefix': 'logo',
        };
        return key in values ? values[key] : fallback;
      }),
    };
    service = new S3Service(configService as never);
  });

  it('uploads to the shared bucket when no override is given', async () => {
    const result = await service.uploadMedia(
      Buffer.from('data'),
      'application/pdf',
      'invoice.pdf',
      'whatsapp-media/company-1/conversation-1',
    );

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Bucket: 'hexa-ai-bucket' }) }),
    );
    expect(result.fileUrl).toContain('hexa-ai-bucket.s3.ap-south-1.amazonaws.com');
  });

  it('routes to the dedicated WhatsApp bucket when a bucket override is given', async () => {
    const result = await service.uploadMedia(
      Buffer.from('data'),
      'application/pdf',
      'invoice.pdf',
      'whatsapp-media/company-1/conversation-1',
      'hexa-ai-whatsapp-media',
    );

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ Bucket: 'hexa-ai-whatsapp-media' }),
      }),
    );
    expect(result.fileUrl).toContain('hexa-ai-whatsapp-media.s3.ap-south-1.amazonaws.com');
    expect(result.key.startsWith('whatsapp-media/company-1/conversation-1/')).toBe(true);
  });

  it('rejects unsupported media types regardless of bucket', async () => {
    await expect(
      service.uploadMedia(
        Buffer.from('data'),
        'application/zip',
        'archive.zip',
        'prefix',
        'hexa-ai-whatsapp-media',
      ),
    ).rejects.toThrow('Unsupported media type for upload');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
