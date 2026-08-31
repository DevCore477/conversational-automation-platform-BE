import { WhatsAppChatService } from './whatsapp-chat.service';

describe('WhatsAppChatService — reply routing reset', () => {
  let conversationRepo: { update: jest.Mock; findOne: jest.Mock };
  let service: WhatsAppChatService;

  beforeEach(() => {
    conversationRepo = { update: jest.fn().mockResolvedValue(undefined), findOne: jest.fn() };
    service = new WhatsAppChatService(
      conversationRepo as never,
      {} as never, // messageRepo
      {} as never, // mediaRepo
      {} as never, // templateService
    );
  });

  it('clears routingMode/agentId/flowId/scriptId/sessionState', async () => {
    await service.resetReplyRouting('conversation-1');

    expect(conversationRepo.update).toHaveBeenCalledWith('conversation-1', {
      routingMode: null,
      agentId: null,
      flowId: null,
      scriptId: null,
      sessionState: null,
    });
  });

  it('resetReplyRoutingForCompany throws when the conversation does not belong to the company', async () => {
    conversationRepo.findOne.mockResolvedValue(null);

    await expect(service.resetReplyRoutingForCompany('company-1', 'conversation-1')).rejects.toThrow(
      'Conversation not found',
    );
    expect(conversationRepo.update).not.toHaveBeenCalled();
  });

  it('resetReplyRoutingForCompany resets when the conversation belongs to the company', async () => {
    conversationRepo.findOne.mockResolvedValue({ id: 'conversation-1', companyId: 'company-1' });

    const result = await service.resetReplyRoutingForCompany('company-1', 'conversation-1');

    expect(result).toEqual({ reset: true });
    expect(conversationRepo.update).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ routingMode: null, agentId: null }),
    );
  });
});
