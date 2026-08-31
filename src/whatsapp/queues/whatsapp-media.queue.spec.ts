import { WhatsAppMediaQueueService } from './whatsapp-media.queue';

const addMock = jest.fn().mockResolvedValue({ id: 'job-1' });

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: addMock })),
}));

/**
 * BullMQ's `Job.validateOptions` rejects a custom jobId containing ':' unless it splits into
 * EXACTLY 3 segments (reserved for repeatable-job ids) — see node_modules/bullmq/dist/cjs/classes/job.js.
 * A `wa-media:${uuid}` jobId (2 segments) throws "Custom Id cannot contain :" at enqueue time,
 * silently dropping every image/video/audio/document job. This test guards against regressing to
 * that shape.
 */
describe('WhatsAppMediaQueueService', () => {
  function isValidBullMqJobId(jobId: string): boolean {
    if (!jobId.includes(':')) {
      return true;
    }
    return jobId.split(':').length === 3;
  }

  it('enqueues with a jobId that does not contain a bullmq-invalid colon shape', async () => {
    const configService = { get: jest.fn().mockReturnValue({}) };
    const service = new WhatsAppMediaQueueService(configService as never);

    await service.enqueue({
      mediaRowId: '11111111-1111-1111-1111-111111111111',
      messageId: 'm1',
      conversationId: 'c1',
      companyId: 'co1',
      mediaType: 'image' as never,
      metaPhoneNumberId: 'phone-1',
      inboundWamid: 'wamid-1',
      userText: '',
    });

    const [, , opts] = addMock.mock.calls[0];
    expect(isValidBullMqJobId(opts.jobId)).toBe(true);
  });
});
