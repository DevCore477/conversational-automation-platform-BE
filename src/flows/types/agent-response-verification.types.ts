/**
 * Input for verifying an AI-generated agent response in conversation flows.
 * Used to validate rephrases, prompt-based generations, and other LLM output
 * against user input and flow context so responses are appropriate and high quality.
 */
export interface AgentResponseVerificationInput {
  /** The AI-generated response to validate (e.g. rephrase, follow-up question). */
  generatedResponse: string;

  /** The user's last message or answer that led to this response. */
  userInput: string;

  /**
   * What the agent was supposed to ask or the current step context.
   * E.g. "Which doctor and time? Dr Bilal (Sat 1–3pm), Dr Robeel (Sun 5–7pm)."
   */
  nodeContext: string;

  /** Slot being collected if any (e.g. "appointment_booking", "confirm"). */
  slotName?: string;

  /** Expected language for the response (e.g. "en", "no"). */
  language?: string;

  /**
   * Type of generation: rephrase, no-response rephrase, flow prompt, script/conversation, etc.
   * Helps the verifier apply the right criteria.
   */
  generationType:
    | 'rephrase'
    | 'no_response_rephrase'
    | 'prompt_response'
    | 'script_response'
    | 'other';

  /** Optional recent conversation turns for coherence. */
  recentTurns?: { role: 'agent' | 'user'; text: string }[];
}

/**
 * Result of verifying an AI-generated agent response.
 */
export interface AgentResponseVerificationResult {
  /** Whether the response is valid and acceptable to use. */
  valid: boolean;

  /**
   * Specific issues found (e.g. wrong language, didn't ask for missing part, bad structure).
   * Empty when valid is true.
   */
  issues: string[];

  /**
   * Optional improved response suggested by the verifier when valid is false.
   * Caller may use this instead of the original generated response.
   */
  suggestion?: string;
}
