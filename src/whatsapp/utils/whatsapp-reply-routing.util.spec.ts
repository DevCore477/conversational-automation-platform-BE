import { WhatsAppRoutingMode } from '../../common/enums/whatsapp.enum';
import type { WhatsAppConversation } from '../../models/whatsapp/whatsapp-conversation.entity';
import type { ResolvedWhatsAppRouting } from '../services/whatsapp-inbound-config.service';
import {
  enrichRoutingFromConversation,
  isSessionRoutingStale,
  resolveConversationRouting,
  toReplyRoutingConfig,
} from './whatsapp-reply-routing.util';

describe('whatsapp-reply-routing.util', () => {
  const fallback: ResolvedWhatsAppRouting = {
    config: {} as ResolvedWhatsAppRouting['config'],
    routingMode: WhatsAppRoutingMode.AI,
    agentId: null,
    flowId: null,
    scriptId: null,
    aiModel: 'gpt-4o-mini',
    aiSystemPrompt: 'Default prompt',
    sendGreetingOnFirstMessage: true,
    markInboundAsRead: true,
    companyId: 'company-1',
  };

  it('toReplyRoutingConfig returns null when routingMode omitted', () => {
    expect(toReplyRoutingConfig({})).toBeNull();
  });

  it('resolveConversationRouting prefers conversation pins', () => {
    const conversation = {
      routingMode: WhatsAppRoutingMode.FLOW,
      agentId: null,
      flowId: 'flow-1',
      scriptId: null,
      companyId: 'company-1',
    } as WhatsAppConversation;

    const resolved = resolveConversationRouting(conversation, fallback);
    expect(resolved.routingMode).toBe(WhatsAppRoutingMode.FLOW);
    expect(resolved.flowId).toBe('flow-1');
  });

  it('isSessionRoutingStale requires init when session has no routingMode', () => {
    const conversation = { routingMode: WhatsAppRoutingMode.AGENT } as WhatsAppConversation;
    expect(isSessionRoutingStale(conversation, null)).toBe(true);
    expect(isSessionRoutingStale(conversation, {})).toBe(true);
  });

  it('isSessionRoutingStale keeps agent+flow progress when session mode is FLOW', () => {
    const conversation = {
      routingMode: WhatsAppRoutingMode.AGENT,
      agentId: 'agent-1',
      flowId: null,
      scriptId: null,
    } as WhatsAppConversation;
    const state = {
      routingMode: WhatsAppRoutingMode.FLOW,
      agentId: 'agent-1',
      flowId: 'flow-1',
      flowState: { currentNode: 'ask_location_node', slots: {}, history: [] },
    };

    expect(isSessionRoutingStale(conversation, state)).toBe(false);
  });

  it('isSessionRoutingStale resets when pinned agent changes', () => {
    const conversation = {
      routingMode: WhatsAppRoutingMode.AGENT,
      agentId: 'agent-2',
      flowId: null,
      scriptId: null,
    } as WhatsAppConversation;
    const state = {
      routingMode: WhatsAppRoutingMode.AGENT,
      agentId: 'agent-1',
      flowId: 'flow-1',
      flowState: { currentNode: 'ask_location_node', slots: {}, history: [] },
    };

    expect(isSessionRoutingStale(conversation, state)).toBe(true);
  });

  it('enrichRoutingFromConversation merges seeded AI overrides', () => {
    const conversation = {
      sessionState: {
        model: 'gpt-4o',
        systemPrompt: 'Campaign-specific prompt',
      },
    } as WhatsAppConversation;

    const enriched = enrichRoutingFromConversation(conversation, fallback);
    expect(enriched.aiModel).toBe('gpt-4o');
    expect(enriched.aiSystemPrompt).toBe('Campaign-specific prompt');
  });
});
