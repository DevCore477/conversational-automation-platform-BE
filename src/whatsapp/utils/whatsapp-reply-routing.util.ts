import { WhatsAppRoutingMode } from '../../common/enums/whatsapp.enum';
import type {
  WhatsAppConversation,
  WhatsAppSessionState,
} from '../../models/whatsapp/whatsapp-conversation.entity';
import type { ResolvedWhatsAppRouting } from '../services/whatsapp-inbound-config.service';
import type {
  WhatsAppReplyRoutingConfig,
  WhatsAppReplyRoutingInput,
} from '../types/whatsapp-reply-routing.types';

export function toReplyRoutingConfig(
  input: WhatsAppReplyRoutingInput | undefined | null,
): WhatsAppReplyRoutingConfig | null {
  if (!input?.routingMode) {
    return null;
  }

  return {
    routingMode: input.routingMode,
    agentId: input.agentId ?? null,
    flowId: input.flowId ?? null,
    scriptId: input.scriptId ?? null,
    aiModel: input.aiModel,
    aiSystemPrompt: input.aiSystemPrompt ?? null,
  };
}

export function resolveConversationRouting(
  conversation: WhatsAppConversation,
  fallback: ResolvedWhatsAppRouting,
): ResolvedWhatsAppRouting {
  const mode = conversation.routingMode as WhatsAppRoutingMode | null | undefined;
  if (!mode) {
    return fallback;
  }

  return {
    ...fallback,
    routingMode: mode,
    agentId: conversation.agentId ?? null,
    flowId: conversation.flowId ?? null,
    scriptId: conversation.scriptId ?? null,
    aiModel: fallback.aiModel,
    aiSystemPrompt: fallback.aiSystemPrompt,
    companyId: conversation.companyId ?? fallback.companyId,
  };
}

export function routingConfigFromCampaign(campaign: {
  routingMode?: string | null;
  agentId?: string | null;
  flowId?: string | null;
  scriptId?: string | null;
  aiModel?: string | null;
  aiSystemPrompt?: string | null;
}): WhatsAppReplyRoutingConfig | null {
  if (!campaign.routingMode) {
    return null;
  }

  return {
    routingMode: campaign.routingMode as WhatsAppRoutingMode,
    agentId: campaign.agentId ?? null,
    flowId: campaign.flowId ?? null,
    scriptId: campaign.scriptId ?? null,
    aiModel: campaign.aiModel ?? undefined,
    aiSystemPrompt: campaign.aiSystemPrompt ?? null,
  };
}

export function mergeRoutingWithFallback(
  config: WhatsAppReplyRoutingConfig,
  fallback: ResolvedWhatsAppRouting,
): ResolvedWhatsAppRouting {
  return {
    ...fallback,
    routingMode: config.routingMode,
    agentId: config.agentId ?? null,
    flowId: config.flowId ?? null,
    scriptId: config.scriptId ?? null,
    aiModel: config.aiModel ?? fallback.aiModel,
    aiSystemPrompt: config.aiSystemPrompt ?? fallback.aiSystemPrompt,
  };
}

/**
 * True when the persisted session should be discarded and re-initialized.
 * Compares pinned routing IDs on the conversation — not routingMode alone —
 * so agent-backed flows (AGENT on conversation, flowState in session) are not reset every turn.
 */
export function isSessionRoutingStale(
  conversation: WhatsAppConversation,
  state: WhatsAppSessionState | null | undefined,
): boolean {
  if (!state?.routingMode) {
    return true;
  }

  const pinnedMode = conversation.routingMode;
  if (!pinnedMode) {
    return false;
  }

  if (conversation.agentId && state.agentId !== conversation.agentId) {
    return true;
  }
  if (conversation.flowId && state.flowId !== conversation.flowId) {
    return true;
  }
  if (conversation.scriptId && state.scriptId !== conversation.scriptId) {
    return true;
  }

  if (state.routingMode !== pinnedMode) {
    const agentWithEmbeddedFlow =
      pinnedMode === WhatsAppRoutingMode.AGENT &&
      state.flowState != null &&
      Boolean(state.flowId);
    if (!agentWithEmbeddedFlow) {
      return true;
    }
  }

  return false;
}

export function enrichRoutingFromConversation(
  conversation: WhatsAppConversation,
  routing: ResolvedWhatsAppRouting,
): ResolvedWhatsAppRouting {
  const seeded = conversation.sessionState;
  if (!seeded) {
    return routing;
  }

  return {
    ...routing,
    aiModel: seeded.model ?? routing.aiModel,
    aiSystemPrompt: seeded.systemPrompt ?? routing.aiSystemPrompt,
  };
}
