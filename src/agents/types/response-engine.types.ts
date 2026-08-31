/**
 * Response engine configuration.
 * An agent uses one of: conversation flow(s), script, or LLM.
 */

/** Single conversation flow as response engine */
export interface ResponseEngineConversationFlow {
  type: 'conversation-flow';
  version?: number;
  /** Primary conversation flow ID (required) */
  conversation_flow_id: string;
  /** Optional additional flow IDs for routing/fallback (e.g. by intent or priority) */
  conversation_flow_ids?: string[];
}

/** Script-based response engine (uses existing call script) */
export interface ResponseEngineScript {
  type: 'script';
  version?: number;
  script_id: string;
}

/** LLM-based response engine (future: custom LLM config per agent) */
export interface ResponseEngineLlm {
  type: 'llm';
  version?: number;
  llm_id: string;
}

export type ResponseEngine =
  | ResponseEngineConversationFlow
  | ResponseEngineScript
  | ResponseEngineLlm;

export function isConversationFlowEngine(
  engine: ResponseEngine,
): engine is ResponseEngineConversationFlow {
  return engine.type === 'conversation-flow';
}

export function isScriptEngine(engine: ResponseEngine): engine is ResponseEngineScript {
  return engine.type === 'script';
}

export function isLlmEngine(engine: ResponseEngine): engine is ResponseEngineLlm {
  return engine.type === 'llm';
}
