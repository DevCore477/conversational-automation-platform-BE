import type { ConversationFlowMode } from '../../agents/types/conversation-flow-mode.types';
import type { ConversationFlowJSON } from '../../flows/types/flows.types';

/**
 * Result of resolving which script and config to use for an inbound call.
 * Used by the voice bridge (language, firstMessage, voiceId) and call state.
 */
export interface ResolvedInboundScript {
  script: string;
  model: string;
  voiceId?: string;
  firstMessage?: string;
  scriptId?: string;
  /** Display name of the call script (for records and dashboard). */
  scriptName?: string;
  /** Language code for ElevenLabs (e.g. "no", "en"). */
  language: string;
  /** Company ID when resolved by called number (inbound to company's number). */
  companyId?: string;
  /**
   * Published conversation flow to run for this inbound call (optional).
   * `flowCompanyId` is the tenant that owns the row in `conversation_flows` (required by the loader).
   */
  flowId?: string;
  flowName?: string;
  /** Tenant that owns the published flow in the database (may differ from caller's company when using platform scripts). */
  flowCompanyId?: string;
  /**
   * Unwrapped flow graph for the bridge (same shape as outbound flow calls). When set, the runtime can use
   * metadata.flow without loading from DB again.
   */
  embeddedFlow?: ConversationFlowJSON;
  /** Platform inbound agent routing (metadata.agentId). */
  agentId?: string;
  /** Agent display name for LLM persona (metadata.agentName). */
  agentName?: string;
  /** Per-agent global instructions (metadata.agentGlobalPrompt). */
  agentGlobalPrompt?: string;
  interruptionSensitivity?: number;
  maxCallDurationMs?: number;
  /** When inbound uses an agent with conversation-flow (rigid vs flex stepping). */
  conversationFlowMode?: ConversationFlowMode;
}
