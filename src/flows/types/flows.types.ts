// flows/types/flows.types.ts

// ---- New structure ----

export interface FlowInstruction {
  type: 'prompt';
  text: string;
}

export interface FlowTransitionCondition {
  type: 'prompt';
  prompt: string;
}

export interface FlowEdge {
  condition: string;
  id: string;
  transition_condition: FlowTransitionCondition;
  destination_node_id?: string;
  /**
   * When the node captures a slot, route to this edge if the captured value
   * contains any of these strings (case-insensitive). Evaluated in edge order.
   */
  when_slot_value?: string[];
}

/** Per-slot extraction and behavior declared in flow JSON (not hardcoded in runtime). */
export interface FlowSlotDefinition {
  /** User may decline; utterances map to decline_value. */
  optional?: boolean;
  /** Stored value when user declines (default: "none"). */
  decline_value?: string;
  /** Substrings that mean decline (defaults applied if optional and omitted). */
  decline_phrases?: string[];
  /** If any appear in the utterance, do not treat as decline (e.g. "coke" on drink step). */
  decline_exclude_if_contains?: string[];
  /** Substring → canonical value; longest keys matched first. */
  aliases?: Record<string, string>;
  /** Allowed values matched by substring. */
  choices?: string[];
  /** Collect multiple alias hits (e.g. add-ons). */
  multi?: boolean;
  /** Joiner for multi (default ", "). */
  multi_join?: string;
}

export interface FlowDisplayPosition {
  x: number;
  y: number;
}

/** Conversation node: agent says something, then listens; edges define next node by condition. */
export interface ConversationNode {
  instruction: FlowInstruction;
  name: string;
  id: string;
  type: 'conversation';
  display_position?: FlowDisplayPosition;
  edges: FlowEdge[];
  start_speaker?: 'agent' | 'user';
  interruption_sensitivity?: number;
  /** Optional: skip waiting for user response and go to this node. */
  skip_response_edge?: FlowEdge & { destination_node_id: string };
  /** Optional: slot to capture from user response (extraction). */
  capture_slot?: string;
  /**
   * When `order_items` already has entries, utterances like "that's all" route here
   * instead of re-asking for product (multi-item flows).
   */
  basket_done_destination?: string;
}

/** End node: agent says goodbye and call ends. */
export interface EndNode {
  instruction?: FlowInstruction;
  name: string;
  id: string;
  type: 'end';
  display_position?: FlowDisplayPosition;
}

/**
 * Transfer call node: hands the call off to another destination.
 * `transfer_destination.type: 'phone_number'` (default when `number` is set) cold/warm-transfers
 * the PSTN leg externally. `type: 'flow'` / `'flow_id'` (both accepted) is an internal handoff — no
 * telephony involved, the same call keeps running but switches to a different published
 * conversation flow in the same company (e.g. escalating from a triage flow to a billing flow),
 * carrying over slots and history. `type: 'agent'` / `'agent_id'` is the same internal handoff, but
 * resolved from a published Agent (voice, language, persona, and the agent's own conversation-flow
 * all switch together) — only agents whose response engine is `conversation-flow` are supported as
 * transfer targets today. The target id belongs in `flowId`/`agentId`, but `number` is accepted as
 * a fallback for either (some callers put the id there regardless of destination type).
 */
export interface TransferCallNode {
  instruction?: FlowInstruction;
  name: string;
  id: string;
  type: 'transfer_call';
  display_position?: FlowDisplayPosition;
  transfer_destination: {
    type: string;
    number?: string;
    /** Id of the published conversation flow to hand off to (when type is 'flow'/'flow_id'). */
    flowId?: string;
    /** Id of the published Agent to hand the call off to (when type is 'agent'/'agent_id'). */
    agentId?: string;
  };
  edge: FlowEdge;
  transfer_option?: {
    type: 'cold_transfer' | 'warm_transfer';
    show_transferee_as_caller?: boolean;
    enable_bridge_audio_cue?: boolean;
  };
  global_node_setting?: { condition: string };
}

/**
 * Tool step node: references a name from `flow.tools[]`, runs server-side, then follows edges.
 * Optional `instruction` for a short line while waiting; edges typically branch on success vs failure.
 */
export interface ToolNode {
  id: string;
  name: string;
  type: 'tool';
  edges: FlowEdge[];
  tool: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  };
  instruction?: FlowInstruction;
  display_position?: FlowDisplayPosition;
  interruption_sensitivity?: number;
  capture_slot?: string;
  skip_response_edge?: FlowEdge & { destination_node_id: string };
}

export type FlowNodeNew = ConversationNode | EndNode | TransferCallNode | ToolNode;

export interface ModelChoice {
  /** e.g. `cascading` or provider-specific values */
  type: string;
  model?: string;
}

/** New flow format: nodes array, start_node_id, global_prompt, etc. */
export interface ConversationFlowJSONNew {
  conversation_flow_id?: string;
  version?: number;
  global_prompt?: string;
  nodes: FlowNodeNew[];
  start_node_id: string;
  start_speaker?: 'agent' | 'user';
  model_choice?: ModelChoice;
  begin_tag_display_position?: FlowDisplayPosition;
  is_published?: boolean;
  /** Optional: explicit intents for matching (can still be used with new nodes). */
  intents?: Record<string, { rules: string[] }>;
  tools?: ElevenLabsToolDefinition[];
  /** Declarative slot extraction / optional-decline rules for this flow. */
  slot_definitions?: Record<string, FlowSlotDefinition>;
}

// ---- Legacy structure (kept for backward compatibility when reading from DB) ----

export interface FlowNodeLegacy {
  title?: string;
  say?: {
    template?: string;
    prompt?: string;
  };
  listen?: {
    capture_slot?: string;
    next?: string;
    intent_scope?: string[];
    fallback?: string;
  };
  transitions?: ({ to: string } | { on_intent: string; to: string })[];
  end?: boolean;
  tool?: {
    name: string;
    payload?: Record<string, unknown>;
  };
  position?: { x: number; y: number };
}

export interface ConversationFlowJSONLegacy {
  start: string;
  nodes: Record<string, FlowNodeLegacy>;
  intents?: Record<string, { rules: string[] }>;
  tools?: ElevenLabsToolDefinition[];
}

/** Flow JSON may be stored in either new (array + start_node_id) or legacy (Record + start) format. */
export type ConversationFlowJSON = ConversationFlowJSONNew | ConversationFlowJSONLegacy;

/** Type guard: flow uses new structure (nodes array). */
export function isNewFlowFormat(flow: ConversationFlowJSON): flow is ConversationFlowJSONNew {
  const f = flow as ConversationFlowJSONNew | ConversationFlowJSONLegacy;
  return Array.isArray(f.nodes) && 'start_node_id' in f && typeof f.start_node_id === 'string';
}

/** Legacy flow type guard. */
export function isLegacyFlowFormat(flow: ConversationFlowJSON): flow is ConversationFlowJSONLegacy {
  const f = flow as unknown as Record<string, unknown>;
  return (
    typeof f.start === 'string' &&
    f.nodes != null &&
    typeof f.nodes === 'object' &&
    !Array.isArray(f.nodes)
  );
}

/**
 * JSON Schema–style object definition (same shape as OpenAI function `parameters`).
 * Used for tool inputs (`parameters`) and documented outputs (`returns`).
 */
export interface FlowToolJsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ElevenLabsToolDefinition {
  name: string;
  description: string;
  parameters: FlowToolJsonSchemaObject;
  /**
   * Declares the shape of JSON returned by the server-side handler after execution.
   * Flow builders and UIs use this for autocomplete, slot hints (`{{field}}`), and docs.
   * Runtime execution does not validate against this schema (handlers may add extra keys).
   */
  returns?: FlowToolJsonSchemaObject & {
    /** Human-readable summary of success vs error payloads (optional). */
    description?: string;
  };
  /**
   * Registry key for server-side execution. Defaults to `name` when omitted.
   * Register handlers with `ConversationFlowToolExecutorService.register(executorKey, handler)`.
   */
  executorKey?: string;
}

// ---- Runtime state (unchanged) ----

export interface FlowRuntimeState {
  flowId: string;
  currentNodeId: string;
  slots: Record<string, unknown>;
  history: {
    role: 'agent' | 'user';
    text: string;
    at: string;
  }[];
}

export interface TurnContext {
  isReprompt: boolean;
  repromptCount: number;
  lastNodeId: string;
  expectingInput: boolean;
  silenceTimeoutMs: number;
}
