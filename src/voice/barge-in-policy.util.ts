/**
 * Pure turn-taking/barge-in policy helpers shared by `ElevenLabsVoiceBridgeService` and
 * `VoiceMediaGateway`. Extracted so the tuned thresholds (onset grace window, minimum barge-in
 * length, interruption sensitivity scaling) live in one place with unit coverage, instead of being
 * buried in a 4,000+ line service with no test harness.
 */

export type CallTurnState = 'idle' | 'agent-speaking' | 'waiting-for-user' | 'processing-user';

export interface BargeInEligibilityInput {
  isWaitingForUser: boolean;
  /** True once the call is ending (goodbye scheduled / hangup pending) — never barge in past that. */
  callEnding: boolean;
  turnState?: CallTurnState;
  /** Explicit session/agent-level interruption_sensitivity override, if set (0 = never, 1 = default). */
  interruptionSensitivity?: number;
  /** Node-level default sensitivity, used only when no explicit override is set on a flow call. */
  nodeInterruptionSensitivity?: number;
  /** Date.now() when turnState last became 'agent-speaking'. */
  agentSpeakingSince?: number;
}

export interface BargeInTuning {
  /** Ignore barge-in for this long after the agent starts speaking (echo/onset guard), in ms. */
  bargeInGraceMs: number;
  /** Minimum partial/final transcript length to treat as a real barge-in vs. echo/noise. */
  bargeInMinChars: number;
  /** now() — injectable for tests; defaults to Date.now. */
  now?: number;
}

export type BargeInIneligibleReason =
  | 'waiting_for_user'
  | 'call_ending'
  | 'not_speaking'
  | 'sensitivity_zero'
  | 'within_onset_grace'
  | 'too_short';

export interface BargeInEligibilityResult {
  eligible: boolean;
  reason?: BargeInIneligibleReason;
}

/**
 * Shared barge-in worthiness test — used both for live partial transcripts and, as a fallback, for
 * final transcripts that arrive while the agent is speaking without a qualifying partial having
 * fired first. Centralizing this keeps the tuned thresholds as one source of truth instead of
 * duplicating/drifting between the partial and final code paths.
 */
export function evaluateBargeInEligibility(
  input: BargeInEligibilityInput,
  trimmedTranscript: string,
  tuning: BargeInTuning,
): BargeInEligibilityResult {
  if (input.isWaitingForUser) return { eligible: false, reason: 'waiting_for_user' };
  if (input.callEnding) return { eligible: false, reason: 'call_ending' };
  if (input.turnState !== 'agent-speaking') return { eligible: false, reason: 'not_speaking' };

  const effectiveSensitivity =
    input.interruptionSensitivity ?? input.nodeInterruptionSensitivity ?? 1;
  if (effectiveSensitivity <= 0) return { eligible: false, reason: 'sensitivity_zero' };

  // Onset grace window: ignore barge-in for the first stretch of agent speech. STT can pick up the
  // agent's own line bleeding back in over the phone line (speakerphone, carrier echo), and without
  // this guard that immediately aborts the agent mid-first-word. An agent that EXPLICITLY configured
  // a high interruption_sensitivity is asking to be cut off fast; shrink the grace window for it
  // instead of applying the same fixed window to every account. Never below a 500ms-equivalent floor
  // (half of `bargeInGraceMs`) — that's still enough for TTS connect + audio travel + echo round-trip.
  const explicitSensitivity = input.interruptionSensitivity;
  const graceMs =
    explicitSensitivity != null && explicitSensitivity > 0.7
      ? Math.round(tuning.bargeInGraceMs * (1 - ((explicitSensitivity - 0.7) / 0.3) * 0.5))
      : tuning.bargeInGraceMs;
  const now = tuning.now ?? Date.now();
  const speakingForMs = now - (input.agentSpeakingSince ?? 0);
  if (speakingForMs < graceMs) return { eligible: false, reason: 'within_onset_grace' };

  // Single short tokens ("uh", "the", "so") are common echo/STT artifacts, not a real interrupt.
  if (trimmedTranscript.length < tuning.bargeInMinChars)
    return { eligible: false, reason: 'too_short' };

  return { eligible: true };
}

/**
 * English-only heuristic: does this transcript sound like it trails off mid-thought (ends on a
 * conjunction, preposition, or filler) rather than a completed utterance? Used to hold a final
 * transcript briefly for a possible continuation instead of immediately firing a full agent turn on
 * a fragment. Deliberately a cheap heuristic, not an LLM call — an added model round trip on every
 * turn would cost far more latency than the pause it's trying to avoid.
 */
const TRAILING_INCOMPLETE_WORDS = new Set([
  'and',
  'but',
  'or',
  'so',
  'because',
  'with',
  'about',
  'for',
  'to',
  'of',
  'the',
  'a',
  'an',
  'my',
  'is',
  'that',
  'which',
  'um',
  'uh',
  'like',
  'well',
]);

export function looksLikeIncompleteUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A clear sentence terminator is a strong signal the thought is complete.
  if (/[.!?]\s*$/.test(trimmed)) return false;

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1]?.replace(/[^a-z']/g, '');
  if (!lastWord) return false;

  return TRAILING_INCOMPLETE_WORDS.has(lastWord);
}
