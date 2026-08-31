import { WhatsAppMediaKind, WhatsAppMediaProcessingStatus } from '../../common/enums/whatsapp.enum';
import type { WhatsAppConversation } from '../../models/whatsapp/whatsapp-conversation.entity';
import { WhatsAppConversationEngineService } from './whatsapp-conversation-engine.service';

describe('WhatsAppConversationEngineService.generateReply — image + caption context', () => {
  let openaiClient: { streamConversationChat: jest.Mock };
  let chatService: { updateSessionState: jest.Mock };
  let contextBuilder: {
    getMediaByRowId: jest.Mock;
    describeCurrentMedia: jest.Mock;
    buildChatHistorySeed: jest.Mock;
  };
  let service: WhatsAppConversationEngineService;

  function fakeStream(text: string) {
    return (async function* () {
      yield { choices: [{ delta: { content: text } }] };
    })();
  }

  beforeEach(() => {
    openaiClient = {
      streamConversationChat: jest.fn().mockResolvedValue(fakeStream('a reply')),
    };
    chatService = { updateSessionState: jest.fn().mockResolvedValue(undefined) };
    contextBuilder = {
      getMediaByRowId: jest.fn(),
      describeCurrentMedia: jest.fn(),
      buildChatHistorySeed: jest.fn().mockResolvedValue([]),
    };

    service = new WhatsAppConversationEngineService(
      openaiClient as never,
      {} as never, // flowRuntime
      {} as never, // flowsService
      {} as never, // agentsService
      {} as never, // callScriptService
      chatService as never,
      contextBuilder as never,
      { get: jest.fn() } as never, // configService
    );
  });

  function buildConversation(): WhatsAppConversation {
    return {
      id: 'conversation-1',
      companyId: 'company-1',
      routingMode: null,
      agentId: null,
      flowId: null,
      scriptId: null,
      sessionState: { routingMode: 'ai', systemPrompt: 'sys', chatHistory: [] },
    } as unknown as WhatsAppConversation;
  }

  it('combines the caption with the image analysis instead of dropping the analysis', async () => {
    contextBuilder.getMediaByRowId.mockResolvedValue({
      id: 'media-1',
      messageId: 'message-1',
      mediaType: WhatsAppMediaKind.IMAGE,
      status: WhatsAppMediaProcessingStatus.COMPLETED,
      s3Url: 'https://cdn/img.jpg',
      visionDescription: 'A clear plastic water bottle with an orange lid on a wooden table.',
    });
    contextBuilder.describeCurrentMedia.mockReturnValue(
      'A clear plastic water bottle with an orange lid on a wooden table.',
    );

    await service.generateReply(
      buildConversation(),
      "What is this in the image i don't understand",
      {} as never,
      'media-1',
    );

    const [messages] = openaiClient.streamConversationChat.mock.calls[0];
    const currentTurn = messages[messages.length - 1];
    const text = Array.isArray(currentTurn.content)
      ? currentTurn.content.find((p: { type: string }) => p.type === 'text')?.text
      : currentTurn.content;

    expect(text).toContain("What is this in the image i don't understand");
    expect(text).toContain('water bottle');
  });

  it('falls back to the media description alone when there is no caption', async () => {
    contextBuilder.getMediaByRowId.mockResolvedValue({
      id: 'media-2',
      messageId: 'message-2',
      mediaType: WhatsAppMediaKind.IMAGE,
      status: WhatsAppMediaProcessingStatus.COMPLETED,
      s3Url: 'https://cdn/img2.jpg',
      visionDescription: 'A skin rash on a forearm.',
    });
    contextBuilder.describeCurrentMedia.mockReturnValue('A skin rash on a forearm.');

    await service.generateReply(buildConversation(), '', {} as never, 'media-2');

    const [messages] = openaiClient.streamConversationChat.mock.calls[0];
    const currentTurn = messages[messages.length - 1];
    const text = Array.isArray(currentTurn.content)
      ? currentTurn.content.find((p: { type: string }) => p.type === 'text')?.text
      : currentTurn.content;

    expect(text).toContain('skin rash');
  });
});
