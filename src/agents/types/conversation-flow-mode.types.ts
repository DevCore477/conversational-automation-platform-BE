/**
 * How strictly the agent follows a conversation flow (when response engine is conversation-flow).
 * - rigid: step-by-step; honor node intent scope and transition conditions strictly.
 * - flex: flow-wide intent matching and looser edge handling; prompts emphasize shared context.
 */
export type ConversationFlowMode = 'rigid' | 'flex';

export function normalizeConversationFlowMode(value: unknown): ConversationFlowMode {
  return value === 'flex' ? 'flex' : 'rigid';
}
