import { WhatsAppRoutingMode } from '../../common/enums/whatsapp.enum';
import { WhatsAppOutboundService } from './whatsapp-outbound.service';

/**
 * Regression coverage for a real support issue: a template/message sent without an explicit
 * `replyRouting` override left a conversation's previously-pinned agent/flow routing untouched
 * forever, so a "fresh" conversation kept replying via an unrelated old flow (e.g. a weather
 * agent). By design now: every send either pins new routing (routingMode given) or resets any
 * existing pin (routingMode omitted) — a send is never a silent no-op on routing state.
 */
describe('WhatsAppOutboundService — reply routing on every send', () => {
  let chatService: { resetReplyRouting: jest.Mock; applyReplyRouting: jest.Mock };
  let service: WhatsAppOutboundService;

  beforeEach(() => {
    chatService = {
      resetReplyRouting: jest.fn().mockResolvedValue(undefined),
      applyReplyRouting: jest.fn().mockResolvedValue(undefined),
    };

    service = new WhatsAppOutboundService(
      {} as never, // client
      {} as never, // nestConfig
      chatService as never,
      {} as never, // conversationService
      {} as never, // contactService
      {} as never, // companyConfig
      {} as never, // inboundConfig
      {} as never, // messageBuilder
      {} as never, // templateService
    );
  });

  function applyReplyRoutingIfConfigured(conversationId: string, ctx: Record<string, unknown>) {
    return (
      service as unknown as {
        applyReplyRoutingIfConfigured: (id: string, c: Record<string, unknown>) => Promise<void>;
      }
    ).applyReplyRoutingIfConfigured(conversationId, ctx);
  }

  it('resets any existing pin when no replyRouting is provided at all', async () => {
    await applyReplyRoutingIfConfigured('conversation-1', {});

    expect(chatService.resetReplyRouting).toHaveBeenCalledWith('conversation-1');
    expect(chatService.applyReplyRouting).not.toHaveBeenCalled();
  });

  it('resets any existing pin when replyRouting is explicitly undefined', async () => {
    await applyReplyRoutingIfConfigured('conversation-1', { replyRouting: undefined });

    expect(chatService.resetReplyRouting).toHaveBeenCalledWith('conversation-1');
    expect(chatService.applyReplyRouting).not.toHaveBeenCalled();
  });

  it('resets rather than pins when replyRouting has no routingMode', async () => {
    await applyReplyRoutingIfConfigured('conversation-1', { replyRouting: { agentId: 'agent-1' } });

    expect(chatService.resetReplyRouting).toHaveBeenCalledWith('conversation-1');
    expect(chatService.applyReplyRouting).not.toHaveBeenCalled();
  });

  it('pins the new routing instead of resetting when routingMode is given', async () => {
    await applyReplyRoutingIfConfigured('conversation-1', {
      replyRouting: { routingMode: WhatsAppRoutingMode.AGENT, agentId: 'agent-1' },
    });

    expect(chatService.applyReplyRouting).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ routingMode: WhatsAppRoutingMode.AGENT, agentId: 'agent-1' }),
    );
    expect(chatService.resetReplyRouting).not.toHaveBeenCalled();
  });
});

/**
 * Regression coverage for a real send failure: sending a template by name (no explicit
 * languageCode) ignored the template's own approved language from the synced DB row and used the
 * global default instead ("en" -> "en_US"). A template approved as e.g. "en_GB" then failed with
 * Meta error 132001 ("Template name does not exist in the translation") even though the template
 * name itself was correct — Meta requires an exact name+language match.
 */
describe('WhatsAppOutboundService — template language resolution', () => {
  let templateService: { findByMetaName: jest.Mock };
  let nestConfig: { get: jest.Mock };
  let service: WhatsAppOutboundService;

  beforeEach(() => {
    templateService = { findByMetaName: jest.fn() };
    nestConfig = { get: jest.fn().mockReturnValue({ metaDefaultLanguage: 'en' }) };

    service = new WhatsAppOutboundService(
      {} as never, // client
      nestConfig as never,
      {} as never, // chatService
      {} as never, // conversationService
      {} as never, // contactService
      {} as never, // companyConfig
      {} as never, // inboundConfig
      {} as never, // messageBuilder
      templateService as never,
    );
  });

  function resolveTemplateForSend(params: Record<string, unknown>, companyId: string | null) {
    return (
      service as unknown as {
        resolveTemplateForSend: (
          p: Record<string, unknown>,
          c: string | null,
        ) => Promise<{ languageCode: string }>;
      }
    ).resolveTemplateForSend(params, companyId);
  }

  it("uses the template's own approved language instead of the global default", async () => {
    templateService.findByMetaName.mockResolvedValue({
      language: 'en_gb',
      bodyPreview: 'preview',
      components: null,
    });

    const result = await resolveTemplateForSend({ templateName: 'appointment_cancelled' }, 'company-1');

    expect(result.languageCode).toBe('en_GB');
    expect(templateService.findByMetaName).toHaveBeenCalledWith('company-1', 'appointment_cancelled', undefined);
  });

  it('still honors an explicit languageCode override from the caller', async () => {
    templateService.findByMetaName.mockResolvedValue({
      language: 'en_gb',
      bodyPreview: 'preview',
      components: null,
    });

    const result = await resolveTemplateForSend(
      { templateName: 'appointment_cancelled', languageCode: 'fr' },
      'company-1',
    );

    expect(result.languageCode).toBe('fr');
    expect(templateService.findByMetaName).toHaveBeenCalledWith('company-1', 'appointment_cancelled', 'fr');
  });

  it('falls back to the global default language when there is no company context', async () => {
    const result = await resolveTemplateForSend({ templateName: 'appointment_cancelled' }, null);

    expect(result.languageCode).toBe('en_US');
    expect(templateService.findByMetaName).not.toHaveBeenCalled();
  });

  it('falls back to the global default when the template row has no matching DB entry', async () => {
    templateService.findByMetaName.mockResolvedValue(null);

    const result = await resolveTemplateForSend({ templateName: 'unknown_template' }, 'company-1');

    expect(result.languageCode).toBe('en_US');
  });
});
