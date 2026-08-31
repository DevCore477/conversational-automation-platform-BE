import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  type ConversationFlowMode,
  normalizeConversationFlowMode,
} from '../agents/types/conversation-flow-mode.types';
import {
  buildAgentGlobalPreambleFromMetadata,
  resolveAgentDisplayNameFromMetadata,
} from './agent-global-prompt.util';
import { evaluateBargeInEligibility, looksLikeIncompleteUtterance } from './barge-in-policy.util';
import {
  flushTwilioPendingAudio,
  queueAudioForTelephony,
  stopTelnyxL16MediaDrain,
  type TelephonyDrainHooks,
} from './telephony-audio-sender.util';
import {
  languageDisplayName,
  languageInstructionForLlmPrompt,
  metadataToCanonicalIso6391,
  pickScriptFirstMessage,
  stripLeadingOverlapForMergedAgentIntro,
} from './call-language';
import {
  interpretUserUtterance,
  localizeFlowAgentSpeech,
  localizeFlowAgentSpeechChunk,
  type UtteranceInterpretation,
} from './utterance-interpreter.util';
import { CallRecordService } from '../calls/services/call-record.service';
import { CallStateService } from '../calls/services/call-state.service';
import { InboundCallInsightService } from '../calls/services/inbound-call-insight.service';
import { CallStatus } from '../calls/types/call-state.types';
import { OpenAIClient } from '../clients/openai/openai.client';
import {
  DRIVER_CANCELLATION_PHRASE_PREFIX,
  DRIVER_CONFIRMATION_PHRASE,
} from '../clients/royal-transfer/royal-transfer-script.util';
import { RoyalTransferService } from '../clients/royal-transfer/royal-transfer.service';
import { TwilioClient } from '../clients/twilio/twilio.client';
import { VoiceClientFactory } from '../clients/voice-client/voice-client.factory';
import { ITTSClient, TTSConfig } from '../clients/voice-client/voice-client.interface';
import { OpenAIModel } from '../common/enums';
import { isPlausibleE164Number, normalizePhoneNumber } from '../common/utils/phone.util';
import { VET_END_CALL_PHRASE } from '../common/utils/vet-clinic-script.util';
import { AgentResponseVerificationService } from '../flows/agent-response-verification.service';
import type { AgentResponseVerificationInput } from '../flows/types/agent-response-verification.types';
import { ConversationFlowToolExecutorService } from '../flows/conversation-flow-tool-executor.service';
import {
  getEffectiveFlow,
  getStartNodeId,
  getNode,
  getSayTemplate,
  getSayPrompt,
  getSayText,
  getListen,
  isEndNode,
  getInterruptionSensitivity,
  getFlowToolDefinitions,
  getFlowSlotDefinition,
  getTransferDialTo,
  getTransferFlowId,
  getTransferAgentId,
} from '../flows/flow-accessors';
import { FlowRuntimeService } from '../flows/flow-runtime.service';
import { FlowsService } from '../flows/flows.service';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';
import {
  formatSlotDefForLlm,
  isKnownMenuShortResponse,
  normalizeSttTranscript,
  transcriptMatchesAnyFlowSlotAlias,
} from '../flows/slot-extraction.util';
import { AgentsService } from '../agents/agents.service';
import { isConversationFlowEngine } from '../agents/types/response-engine.types';
import type { CallTranscriptRole, CallTranscriptTurn } from '../models/calls/call-transcript.types';
import { TelnyxClient } from '../clients/telnyx/telnyx.client';
import { TelnyxPhoneNumberService } from '../clients/telnyx/telnyx-phone-number.service';
import { PlatformInboundVoiceService } from '../platform/platform-inbound-voice.service';
import {
  messageImpliesSupportHandoff,
  messageImpliesUserWantsHuman,
} from './support-transfer.util';

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

interface CallSession {
  twilioWs: WebSocket;
  streamSid: string;
  callSid: string;
  ready: boolean;
  conversationHistory: ConversationMessage[];
  /** Non-flow (script) calls only: the part of `conversationHistory[0]`'s system prompt that
   * follows the language instruction (agent persona + task script + behavior guidelines) — stored
   * so `setConversationLanguage` can rebuild that system message with a fresh language instruction
   * on every switch, instead of leaving the call-start language baked in forever. Without this,
   * the system prompt keeps telling the model "you MUST respond only in <original language>...
   * do not switch" even after the active language legitimately changes, and the model periodically
   * reverts to it. */
  systemPromptAfterLanguageInstruction?: string;
  /** Set once the first real user turn has been processed — used to detect a reflexive
   * "Hello?"-type phone-greeting as the very first thing the user says (see
   * `isGenericPhoneGreetingOnly`), which should get a brief acknowledgment instead of a full LLM
   * turn (that tends to re-introduce the agent, sounding like a repeated greeting). */
  hasHadFirstUserTurn?: boolean;
  isProcessing: boolean;
  ttsClient: ITTSClient;
  openaiClient: OpenAIClient;
  voiceConfig: TTSConfig;
  endCallTimeoutId?: NodeJS.Timeout;
  /** Timer to end call when agent maxCallDurationMs is reached. */
  maxCallDurationTimeoutId?: NodeJS.Timeout;
  userEndCallRequested?: boolean;
  agentEndCallSignaled?: boolean;
  /** Guards against re-firing the highest-priority human-transfer interrupt while one is already in flight. */
  humanTransferRequested?: boolean;
  isFlowCall?: boolean;
  flowState?: any;
  currentFlow?: any;
  currentNodeId?: string;
  lastUserTranscript?: string;
  lastAgentResponse?: string;
  messageSequence?: number;
  audioChunksPending?: number;
  turnState?: 'idle' | 'agent-speaking' | 'waiting-for-user' | 'processing-user';
  /** Date.now() when turnState last became 'agent-speaking' — used to ignore barge-in for a brief
   * onset grace window so the agent's own line/echo bleed doesn't immediately self-interrupt. */
  agentSpeakingSince?: number;
  /** Incremented once per agent speech attempt (see `beginSpeechGeneration`) — `turnState ===
   * 'agent-speaking'` alone can't distinguish an aborted speech attempt's still-in-flight TTS
   * callbacks from a NEWER attempt that started right after it (e.g. an interruption immediately
   * followed by "Sorry, go ahead..."): both see turnState as 'agent-speaking'. Every audio-chunk
   * and speech-completion check also compares against this generation so stale bytes/completion
   * from a superseded attempt are dropped instead of bleeding into (or prematurely ending) the
   * current one. */
  audioGeneration?: number;
  /** Incremented once per incoming user turn attempt (see `processFlowTurnWithLock`) — lets a
   * long-running background operation with no cancellation (a tool-loop turn) detect it was
   * superseded by a newer turn before speaking its (now stale) answer. */
  turnSequence?: number;
  /** Last tool-call filler phrase spoken (see `speakToolCallFiller`) — avoids repeating the same
   * filler twice in a row, consistent with the "never force a filler into every reply" rule in
   * AGENT_BEHAVIOR_GUIDELINES. */
  lastFillerPhrase?: string;
  recentTranscripts?: Map<string, number>;
  noResponseTimeoutId?: NodeJS.Timeout;
  // Retained from original
  endCallAfterFirstMessage?: boolean;
  firstMessageEndScheduled?: boolean;
  processingLock?: Promise<void>;
  releaseLock?: () => void;
  // Audio accumulation for STT
  audioBuffer?: Buffer[];
  transcriptionTimeoutId?: NodeJS.Timeout;
  isListening?: boolean;
  // Callbacks for gateway to know when TTS starts/ends (so it can pause/resume user audio processing)
  onTtsStart?: (callSid: string) => void;
  onTtsEnd?: (callSid: string) => void;
  /** Called when user interrupted agent (so gateway can allow the next final transcript through) */
  onInterruption?: (callSid: string) => void;
  turnContext: {
    isWaitingForUser: boolean;
    lastUserActivity: number;
    silenceTimeoutId?: NodeJS.Timeout;
    partialTranscript: string;
    isProcessingPartial: boolean;
  };
  interruptState?: {
    wasInterrupted: boolean;
    interruptedAt: number;
    waitForUserMs: number;
  };
  /** Set by handleInterruption so the next final transcript is treated as post-interruption (human-like response) */
  interruptionUtterance?: string;
  interruptionAt?: number;
  /** Call language (e.g. 'no' for Norwegian); used for first message and prompt responses */
  language?: string;
  /** Latest detected user spoken language (ISO 639-1); drives agent reply + TTS model. */
  userSpokenLanguage?: string;
  /** Last LLM interpretation of user speech (multilingual calls). */
  lastUtteranceInterpretation?: UtteranceInterpretation;
  /** Mirrors flowState.conversationLanguage for quick access. */
  conversationLanguage?: string;
  /** Last transcript actually forwarded into a flow turn, and which node it was processed on.
   * Used to detect late STT finals that are just a trailing fragment of an utterance already
   * consumed (e.g. VAD over-segmenting one sentence into two finals, the second arriving seconds
   * later) — without this, that stale fragment gets treated as a brand-new turn on whatever node
   * the flow has since moved to, which can prematurely end the call. */
  lastConsumedTranscript?: { text: string; at: number; nodeId?: string };
  /** Agent-level interruption sensitivity (0 = do not allow barge-in, 1 = allow). Overrides/defaults node-level when set. */
  interruptionSensitivity?: number;
  /** Set for one turn right after an explicit language-switch request is applied; consumed once
   * to inject a one-time acknowledgement instruction into that turn's LLM prompt — see
   * `applyConversationLanguageSwitch` and its call sites in `processUserTranscript`. */
  pendingLanguageAckLang?: string;
  conversationState?: {
    lastAgentMessageTime: number;
    lastUserMessageTime: number;
    consecutiveReprompts: number;
    isInCoolDown: boolean;
    expectedResponseTime: number; // When we expect user to respond by
  };
  /** After speaking a reprompt, ignore short/noise input for this long so user has time to respond */
  lastRepromptAt?: number;
  /**
   * After this agent line finishes playing, run a handoff:
   * - `pstn_transfer`: cold-transfer the carrier leg externally (Twilio redirect or Telnyx transfer).
   * - `flow_transfer`: internal handoff — no telephony, same call switches to another published
   *   flow in the same company (see `runFlowTransferSequence`).
   * - `agent_transfer`: same as `flow_transfer`, resolved from a published Agent's own flow, plus
   *   that agent's voice/language/persona (see `runAgentTransferSequence`).
   */
  pendingPostSpeechAction?:
    | { kind: 'pstn_transfer'; to: string }
    | { kind: 'flow_transfer'; flowId: string }
    | { kind: 'agent_transfer'; agentId: string };
  /** Deferred reprompt: speak only if user has not spoken again by the time the timer fires */
  pendingReprompt?: {
    nodeId: string;
    responseText: string;
    timeoutId: NodeJS.Timeout;
  };
  /** A final transcript that looked incomplete (trailing conjunction/filler — see
   * `looksLikeIncompleteUtterance`) and is being held briefly in case the user's next final
   * transcript is really a continuation of the same thought, rather than firing a full agent turn
   * on a fragment. */
  pendingIncompleteUtterance?: {
    text: string;
    timeoutId: NodeJS.Timeout;
  };
  /** μ-law 8k pending for Twilio; drained in 160-byte / 20ms frames */
  twilioMulawPending?: Buffer;
  /** True while a drain loop is sending frames (prevents concurrent drains) */
  twilioDrainActive?: boolean;
  /** Telnyx L16 16kHz mono PCM (little-endian); drained in 640-byte / 20ms frames */
  telnyxPcm16Pending?: Buffer;
  /** Fixed 20ms wall-clock drain for Telnyx (avoids burst sends that glitch RTP playback). */
  telnyxL16DrainIntervalId?: NodeJS.Timeout;
  /** From call metadata when call uses an agent; injected into script/flow LLM prompts */
  agentGlobalPreamble?: string;
  /** Agent display name resolved from metadata (global prompt name first, then agentName). */
  agentDisplayName?: string;
  /** From metadata (agent with conversation-flow); drives rigid vs flex runtime and prompt-node behavior */
  conversationFlowMode?: ConversationFlowMode;
  /** From metadata.callType === 'outbound' — outbound opening lines and agent intro differ from inbound. */
  isOutboundCall?: boolean;
  /** True for stdin/stdout local dev: no TTS, no Twilio media */
  terminalTextOnly?: boolean;
  /** Fired from cleanupSession after the session is removed (e.g. close readline) */
  onTerminalSessionEnd?: () => void;
  /** AbortController for cancelling in-flight LLM requests */
  llmAbortController?: AbortController;

  /** Streaming STT WebSocket connection */
  sttSocket?: WebSocket;
}

/** Unicode scripts relevant to this deployment's markets (English/Urdu/Hindi/Punjabi/Arabic). */
const SCRIPT_PATTERNS: RegExp[] = [
  /\p{Script=Latin}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Gurmukhi}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Bengali}/u,
];

/**
 * Real speech in one utterance essentially never hops between 3+ unrelated writing systems
 * (e.g. Latin "MICR" glued to nonsense Gurmukhi glued to Latin again) — that pattern is a
 * signature of STT hallucinating on background noise or a bad phone line, not a bilingual
 * speaker code-switching (which stays within 1-2 scripts, and each language's own words).
 */
function countDistinctScripts(text: string): number {
  return SCRIPT_PATTERNS.reduce((count, re) => (re.test(text) ? count + 1 : count), 0);
}

/** Placeholder WebSocket for terminal REPL — no Twilio stream */
export function createTerminalDummyWebSocket(): WebSocket {
  return {
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
    send: () => undefined,
    close: () => undefined,
    removeAllListeners: () => undefined,
    readyState: 1,
  } as unknown as WebSocket;
}

@Injectable()
export class ElevenLabsVoiceBridgeService {
  private readonly logger = new Logger(ElevenLabsVoiceBridgeService.name);
  private sessions = new Map<string, CallSession>();
  /** Dedupe concurrent support transfers for the same call SID. */
  private readonly supportTransfersStarted = new Set<string>();
  /**
   * While set, `performEndCall` skips Telnyx teardown — used during support handoff (hold message + tail buffer
   * + `transfer`) so a media WS `stop` does not hang up the leg before `transfer` completes.
   */
  private readonly telnyxSupportHandoffHangupSuppressed = new Set<string>();
  /**
   * Guards against a concurrent double-fire of a flow-to-flow transfer for the same call (e.g. the
   * post-speech action and a race from a second trigger). Unlike PSTN transfers, a flow transfer
   * doesn't end the session, so this is removed once the transfer settles — the call can legitimately
   * transfer again later (e.g. triage -> billing -> escalations).
   */
  private readonly flowTransfersInProgress = new Set<string>();
  private readonly openaiClient: OpenAIClient;
  /**
   * callSid -> cleanup timer, set the first time we ask the provider to hang up this call.
   * `performEndCall` runs on every path a call can end through (flow goodbye, max duration, user
   * request, AND the gateway's WebSocket-close handler calling `stop()` unconditionally) — on a
   * normal call two or more of those fire for the same callSid. Without this guard, every one
   * after the first re-sends a hangup command for a call the provider already tore down, and
   * Telnyx correctly (but noisily) answers "This call is no longer active" every single time.
   */
  private readonly hangupCommandSent = new Map<string, NodeJS.Timeout>();

  /**
   * callSid -> a TTS client whose WebSocket was opened (via prewarmOutboundTts) while the outbound
   * call was still ringing, so the greeting doesn't pay the ElevenLabs connect+TLS handshake after
   * the user answers. `start()` claims this instead of creating a fresh client when present.
   */
  private readonly prewarmedTtsClients = new Map<string, ITTSClient>();
  /** callSid -> timer that discards an unclaimed prewarmed TTS client (call never answered/failed). */
  private readonly prewarmedTtsExpiry = new Map<string, NodeJS.Timeout>();
  /** Outbound calls are answered or fail well within this window; anything left warm past it is a
   * leaked socket (no-answer, busy, voicemail, failed dial) and must be closed, not kept open. */
  private static readonly PREWARM_TTS_EXPIRY_MS = 45_000;

  // Constants from original
  private readonly END_CALL_AFTER_FIRST_MESSAGE_BUFFER_MS = 2500;
  private readonly END_CALL_ON_ERROR_BUFFER_MS = 5000;
  private readonly END_CALL_FALLBACK_MS = 35000;
  /** Every call is ended at or before this duration (agent `maxCallDurationMs` is capped to this). */
  private static readonly MAX_CALL_DURATION_MS = 5 * 60 * 1000;
  private readonly END_CALL_AFTER_GOODBYE_BUFFER_MS = 5000; // minimum for short goodbyes
  private readonly END_CALL_AFTER_GOODBYE_MAX_MS = 10000; // cap for long goodbye messages
  private readonly END_CALL_AFTER_USER_REQUEST_BUFFER_MS = 3000;
  // Constants for responsive timing (reduced to minimize user wait on calls)
  private readonly MIN_RESPONSE_DELAY_MS = 0; // No artificial pause before responding
  // private readonly POST_SPEECH_SILENCE_MS = 250; // Cooldown after TTS ends before listening (keep low for snappy turns)
  /** If user doesn't respond this long after agent *finishes* speaking, ask again with filler rephrase */
  // private readonly NO_RESPONSE_REPHRASE_MS = 5000;
  private readonly MAX_REPROMPTS = 5;
  /** After this much silence following agent speech, rephrase and ask again (no-response rephrase). */
  // private readonly NO_RESPONSE_REPHRASE_MS = 12_000;
  // private readonly REPROMPT_DELAY_MS = 600; // Brief pause before reprompt only when >1 reprompt
  /** Wait this long after a reprompt before accepting input (stops rapid-fire reprompts from noise) */
  private readonly REPROMPT_WAIT_FOR_USER_MS = 2800;
  /**
   * Delay before TTS for a flow reprompt. Final STT commits already mean the user stopped speaking;
   * a multi-second pause only adds dead air. Keep short — pending reprompt is still cleared if the user speaks again.
   */
  // private readonly REPROMPT_PAUSE_BEFORE_SAY_MS = 1500;
  private readonly LONG_SPEECH_THRESHOLD_MS = 8000; // If agent spoke > 8s,
  /** After tool chain, `prefaceResponseText` is the last agent line in history — only speak it if short (avoid replaying long context twice). */
  private readonly PREFACE_VOICE_MAX_CHARS = 160;
  /** Tail after the main handoff line so PSTN playback can finish before the next prompt (ms). */
  private readonly SUPPORT_TRANSFER_TAIL_BUFFER_MS = 1200;
  /** Pause after the “connecting to support” line before issuing the carrier transfer (ms). */
  private readonly SUPPORT_TRANSFER_AFTER_HOLD_BUFFER_MS = 500;
  /** Pause after a flow-to-flow transition line before speaking the new flow's first message (ms). */
  private readonly FLOW_TRANSFER_TRANSITION_PAUSE_MS = 400;

  // Replace existing constants with these:
  private readonly POST_SPEECH_SILENCE_MS = 50; // Was 250ms
  private readonly REPROMPT_DELAY_MS = 200; // Was 600ms
  private readonly REPROMPT_PAUSE_BEFORE_SAY_MS = 800; // Was 1500ms
  private readonly INTERRUPTION_GRACE_MS = 8000; // Was 12000ms
  /** Ignore barge-in for this long after the agent starts speaking — avoids self-interruption from
   * the agent's own line bleeding back into STT (speakerphone/carrier echo).
   * Must cover: TTS connect latency (~300–500ms) + audio travel to caller + echo round-trip (~300ms).
   * 400ms was too short — echo arrived after the grace window, killing every agent response.
   * 1500ms was too long — users had to wait 1.5s of speaking before the agent would stop.
   * 1000ms fixed the echo false-positives but made every real interruption wait a full second
   * before the agent reacts, which reads as "talks over you no matter what." 700ms is a deliberate
   * step back toward more responsive barge-in — still above the ~400ms point where echo was
   * observed arriving, but with less margin than 1000ms. If the agent starts cutting itself off
   * with nobody talking (the original symptom this constant fixes), raise this back toward 1000ms
   * — that's the echo, not a real interruption. */
  private readonly BARGE_IN_GRACE_MS = 700;
  /** Minimum partial-transcript length to treat as a real barge-in (shorter is usually echo/noise).
   * 4 was too low — echo of short phrases like "Yes, ma'am." (10 chars) at ~1s into speech
   * would fire false barge-ins with the 1000ms grace window. 20 chars ≈ 4+ words of real speech
   * was the fix, but it also means short, clear interruptions ("wait", "no stop", "actually hold
   * on") never register at all — the agent talks straight through them. 12 keeps a margin above
   * the ~10-char echo example that caused false positives while letting short-but-real
   * interruptions through. If short-phrase echo false-positives reappear, raise this back toward
   * 20 rather than lowering it further. */
  private readonly BARGE_IN_MIN_CHARS = 12;
  /** How long to hold a final transcript that looks incomplete (see `looksLikeIncompleteUtterance`)
   * before processing it as-is, giving the user a brief window to continue the same thought instead
   * of the agent replying to a fragment. Deliberately short — this only fires for utterances that
   * already look unfinished, so it should read as a natural beat, not a stall. */
  private readonly INCOMPLETE_UTTERANCE_HOLD_MS = 500;

  /** Estimate delay so user hears full goodbye before hangup (~12 chars/sec speech). */
  private getGoodbyeDelayMs(responseText: string): number {
    const estimatedPlaybackMs = (responseText.length / 12) * 1000;
    return Math.min(
      this.END_CALL_AFTER_GOODBYE_MAX_MS,
      Math.max(this.END_CALL_AFTER_GOODBYE_BUFFER_MS, Math.ceil(estimatedPlaybackMs)),
    );
  }

  private readonly USER_END_CALL_PHRASES = [
    'hang up',
    'end the call',
    'goodbye',
    'bye bye',
    'bye',
    'talk to you later',
    'see you later',
    'disconnect',
    'close the call',
    'stop calling',
    'end call',
    'finish the call',
    'terminate the call',
  ];

  private readonly AGENT_END_PHRASES = [
    'goodbye',
    'have a great day',
    'take care',
    'talk to you soon',
    'end of call',
    'glad i could help',
    'we are ending this call',
    'ending the call',
  ];

  private readonly AGENT_BEHAVIOR_GUIDELINES = `
## Behavioral guidelines (always follow)
- Be warm, polite, and courteous at all times. Use please, thank you, and kind phrasing. Never sound curt, dismissive, or rude.
- Stay on-topic based on the user's current task.
- Background noise and unclear speech: If what you hear is unclear, sounds like background noise, or is not clearly directed at you, do NOT guess or respond to it. Politely ask: "I'm having trouble hearing you clearly. Could you please repeat that in English?" or "There seems to be a lot of background noise. Could you speak in English when you're ready?" Do not treat unclear or noisy input as a real question or command.
- For personal or off-topic questions (e.g. "How's your family?", "What's your health?"), thank the user kindly and gently explain you're here only to help with the task: e.g. "Thank you for asking. I'm only able to help with this booking today. Is there anything else about the pickup I can help with?"
- Allow normal greetings and respond in a friendly way, but gently steer back to the task if the conversation drifts.
- Maintain a professional, respectful, and helpful tone. Keep boundaries with kindness.
- When redirecting off-topic, do it gently: e.g. "I'd be happy to help with that another time. For now, is there anything about this booking I can help with?"
- For inappropriate or abusive content, politely decline and offer to help with the task: e.g. "I'm here to help with your booking. Is there something I can assist you with?"
- Keep responses concise and clear unless the user asks for more detail.
- Answer each question only once. If the user asks the same question again shortly after (e.g. because of delay or they didn't hear your answer), do NOT give the full answer again. Give one answer only: either finish your current answer if you're already speaking, or say a brief confirmation once, e.g. "As I said, [one-line answer]. Anything else?" or "That's [brief answer]. Can I help with something else?" Never repeat the same full answer twice for the same question.
- When the user says they want to end the call, hang up, goodbye, or similar, politely confirm and end the call gracefully.
- Talk like an experienced phone rep, not a script reader: short, interactive turns over long monologues. Don't restate or summarize the user's question back to them before answering — just answer it. Ask one question at a time.
- Natural fillers ("Hmm," "Alright," "I see," "Got it," "One moment...") are fine sparingly, only where a human genuinely would pause — never more than one per response, and never in two consecutive turns. Do not force a filler into every reply.
- If the user interrupts you mid-response, address what they just said directly. Do not resume or re-explain the point you were interrupted on unless they ask for it.
`.trim();

  constructor(
    private readonly configService: ConfigService,
    private readonly callStateService: CallStateService,
    private readonly callRecordService: CallRecordService,
    private readonly twilioClient: TwilioClient,
    private readonly telnyxClient: TelnyxClient,
    private readonly telnyxPhoneNumberService: TelnyxPhoneNumberService,
    private readonly platformInboundVoice: PlatformInboundVoiceService,
    @Optional()
    private readonly royalTransferService: RoyalTransferService | null,
    @Optional()
    @Inject(forwardRef(() => FlowsService))
    private readonly flowsService: FlowsService | null,
    @Optional()
    @Inject(forwardRef(() => AgentsService))
    private readonly agentsService: AgentsService | null,
    @Inject(forwardRef(() => FlowRuntimeService))
    private readonly flowRuntime: FlowRuntimeService,
    @Optional()
    private readonly verificationService: AgentResponseVerificationService | null,
    private readonly flowToolExecutor: ConversationFlowToolExecutorService,
    private readonly voiceClientFactory: VoiceClientFactory,
    private readonly inboundInsightService: InboundCallInsightService,
  ) {
    const openaiKey = this.configService.getOrThrow<string>('openai.apiKey');
    this.openaiClient = new OpenAIClient(openaiKey);
  }

  /**
   * ElevenLabs voice IDs are UUIDs or short alphanumeric ids (e.g. cgSgspJ2msm6clMCkdW9).
   * Chatterbox expects file paths — avoid sending cloud voice ids to Chatterbox.
   */
  private static looksLikeElevenLabsVoiceId(id: string): boolean {
    const t = id.trim();
    if (!t || t.includes('/') || t.includes('\\') || t.endsWith('.mp3') || t.endsWith('.wav')) {
      return false;
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
      return true;
    }
    // ElevenLabs non-UUID voice ids (typically 20–24 chars alnum)
    if (/^[a-zA-Z0-9]{18,28}$/.test(t)) {
      return true;
    }
    return false;
  }

  /** Active conversation language (sticky once the user speaks). */
  private getActiveConversationLanguage(session: CallSession): string {
    const raw =
      session.userSpokenLanguage ??
      session.conversationLanguage ??
      session.flowState?.conversationLanguage ??
      session.language ??
      'en';
    return metadataToCanonicalIso6391(raw);
  }

  private setConversationLanguage(session: CallSession, lang: string): void {
    const canon = metadataToCanonicalIso6391(lang);
    session.language = canon;
    session.userSpokenLanguage = canon;
    session.conversationLanguage = canon;
    if (session.flowState) {
      session.flowState.conversationLanguage = canon;
    }
    const callState = this.callStateService.findOne(session.callSid);
    session.voiceConfig = this.buildVoiceConfig(callState ?? { metadata: {} }, canon);

    // Non-flow (script) calls build their system prompt once at call start (the flow path
    // rebuilds it fresh every turn already, so it needs no equivalent fix here). Without this,
    // conversationHistory[0] keeps the ORIGINAL language's "you MUST respond only in X... do not
    // switch" instruction forever, actively fighting every subsequent turn after a real switch.
    if (session.conversationHistory[0]?.role === 'system') {
      session.conversationHistory[0].content = [
        languageInstructionForLlmPrompt(canon),
        session.systemPromptAfterLanguageInstruction,
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    // The new language likely means a different TTS voiceId/modelId, which misses the warm-socket
    // cache (keyed on voiceId::modelId) — the last prewarm() call (end of the previous turn) only
    // warmed the OLD language's connection. Kick off a prewarm for the new config immediately so
    // the ~1s connect handshake overlaps with this turn's response generation instead of the very
    // turn that just switched language always paying it cold.
    if (!session.terminalTextOnly) {
      try {
        session.ttsClient.prewarm?.(session.voiceConfig);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Below this length, a language switch is not trusted — short/noisy fragments ("जी, madam.",
   * "1942.", a mistranscribed aside) are exactly where STT/LLM language detection is least
   * reliable, and flipping the whole call's language and TTS voice off a 2-3 word fragment is
   * jarring and usually wrong. */
  private static readonly MIN_CHARS_FOR_LANGUAGE_SWITCH = 12;

  /**
   * Resolves and applies the active conversation language for this turn, per priority:
   * (1) an explicit request this turn ("can we speak English?") — switches immediately, no
   *     length/confidence gate, since this is an LLM classification of intent, not a fuzzy
   *     spoken-language guess; (2) the organically-detected spoken language — switches on this
   *     SAME turn (no multi-turn confirmation) as long as the transcript clears the length-based
   *     noise guard below; (3) neither present — stays on the previously-established active
   *     language (a no-op), which is also the default/greeting language until the first switch.
   */
  private applyConversationLanguageSwitch(
    session: CallSession,
    params: { explicitRequestLang?: string; detectedLang?: string; transcript: string },
  ): { switched: boolean; kind: 'explicit' | 'implicit' | 'none'; newLang?: string } {
    const current = this.getActiveConversationLanguage(session);

    if (params.explicitRequestLang) {
      const canon = metadataToCanonicalIso6391(params.explicitRequestLang);
      if (canon === current) return { switched: false, kind: 'none' };
      this.logger.log(`🌐 Explicit language switch to "${canon}" for ${session.callSid}`);
      this.setConversationLanguage(session, canon);
      return { switched: true, kind: 'explicit', newLang: canon };
    }

    if (params.detectedLang) {
      const canon = metadataToCanonicalIso6391(params.detectedLang);
      if (canon === current) return { switched: false, kind: 'none' };
      if (
        params.transcript.trim().length < ElevenLabsVoiceBridgeService.MIN_CHARS_FOR_LANGUAGE_SWITCH
      ) {
        this.logger.debug(
          `⏭️ Ignoring language switch to "${canon}" — transcript too short to trust ("${params.transcript}") for ${session.callSid}`,
        );
        return { switched: false, kind: 'none' };
      }
      this.logger.log(`🌐 Implicit language switch to "${canon}" for ${session.callSid}`);
      this.setConversationLanguage(session, canon);
      return { switched: true, kind: 'implicit', newLang: canon };
    }

    return { switched: false, kind: 'none' };
  }

  /**
   * Reads and clears `session.pendingLanguageAckLang` (set for one turn right after an explicit
   * language-switch request), returning a one-time system-role instruction for this turn's LLM
   * call so it blends a natural acknowledgement into its normal response instead of a separately
   * prepended fixed phrase — or `undefined` when there's nothing pending. Safe to call from
   * multiple places; only the first caller in a turn gets a non-undefined result.
   */
  private consumePendingLanguageAckInstruction(session: CallSession): string | undefined {
    const ackLang = session.pendingLanguageAckLang;
    if (!ackLang) return undefined;
    session.pendingLanguageAckLang = undefined;
    const name = languageDisplayName(ackLang);
    return `The user just explicitly asked to switch to ${name}. Briefly acknowledge this once (e.g. "Of course!"), then answer their message below, entirely in ${name}.`;
  }

  private lastAgentHistoryLine(session: CallSession): string | undefined {
    const history = session.flowState?.history as { role: string; text: string }[] | undefined;
    if (!history?.length) return undefined;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'agent') return history[i].text;
    }
    return undefined;
  }

  private patchLastAgentHistoryText(session: CallSession, spokenText: string): void {
    const history = session.flowState?.history as { role: string; text: string }[] | undefined;
    if (!history?.length) return;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'agent') {
        history[i].text = spokenText;
        return;
      }
    }
  }

  /** Localize English flow-script lines; skip LLM-generated lines (already in conversation language). */
  private async prepareAgentSpeech(
    session: CallSession,
    text: string,
    opts?: { fromFlowScript?: boolean },
  ): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed || !opts?.fromFlowScript) return trimmed;

    const lang = this.getActiveConversationLanguage(session);
    if (lang === 'en') return trimmed;

    const localized = await localizeFlowAgentSpeech(this.openaiClient, {
      text: trimmed,
      targetLanguageIso6391: lang,
      recentAgentLine: this.lastAgentHistoryLine(session),
    });
    if (localized !== trimmed) {
      this.logger.log(
        `🌐 Localized agent line (${lang}): "${trimmed.substring(0, 50)}..." → "${localized.substring(0, 50)}..."`,
      );
    }
    return localized;
  }

  /**
   * Speak a flow-script line, localizing it first if needed.
   *
   * For English, or replies that are a single sentence, this is exactly `prepareAgentSpeech` +
   * `speakText` (one translation call, then TTS) — no behavior change.
   *
   * For multi-sentence non-English replies (order summaries, longer confirmations), translation
   * and TTS are pipelined sentence-by-sentence so audio starts after the first sentence translates
   * instead of waiting for the whole reply to translate first.
   *
   * Returns the (possibly localized) text actually spoken, for history bookkeeping.
   */
  private async speakFlowResponse(
    session: CallSession,
    text: string,
    isReprompt = false,
  ): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) return trimmed;

    const lang = this.getActiveConversationLanguage(session);
    const englishChunks = this.splitIntoSpeakableChunks(trimmed);

    if (lang === 'en' || session.terminalTextOnly || englishChunks.length <= 1) {
      const toSpeak = await this.prepareAgentSpeech(session, trimmed, { fromFlowScript: true });
      await this.speakText(session, toSpeak, isReprompt);
      return toSpeak;
    }

    return this.speakTranslatedChunksPipelined(session, trimmed, englishChunks, lang, isReprompt);
  }

  /**
   * Translate `englishChunks` (sentences of `fullText`) one at a time, feeding each into a
   * streaming TTS queue as soon as it's translated — mirrors the LLM-token-to-TTS pipeline already
   * used in `processAIConversationTurn`, but pipelines sentence-level translation calls instead of
   * LLM token deltas.
   */
  private async speakTranslatedChunksPipelined(
    session: CallSession,
    fullText: string,
    englishChunks: string[],
    targetLang: string,
    isReprompt: boolean,
  ): Promise<string> {
    if (!session.conversationState) {
      session.conversationState = {
        lastAgentMessageTime: 0,
        lastUserMessageTime: 0,
        consecutiveReprompts: 0,
        isInCoolDown: false,
        expectedResponseTime: 0,
      };
    }
    if (isReprompt) {
      session.conversationState.consecutiveReprompts++;
    } else {
      session.conversationState.consecutiveReprompts = 0;
    }

    session.turnState = 'agent-speaking';
    session.agentSpeakingSince = Date.now();
    session.lastAgentResponse = fullText;
    session.onTtsStart?.(session.callSid);
    session.conversationState.isInCoolDown = true;
    const myGeneration = this.beginSpeechGeneration(session);

    const firstEnglishChunk = englishChunks[0] ?? fullText;
    if (this.detectAgentEndCallIntent(firstEnglishChunk)) {
      this.handleAgentEndCallSignal(
        session.callSid,
        'agent_goodbye',
        this.getGoodbyeDelayMs(fullText),
      );
    }
    if (firstEnglishChunk.includes(DRIVER_CONFIRMATION_PHRASE)) {
      this.handleAgentEndCallSignal(
        session.callSid,
        'driver_confirmed',
        this.getGoodbyeDelayMs(fullText),
      );
    }

    const translatedChunks: string[] = [];
    const ttsQueue: string[] = [];
    let ttsQueueClosed = false;
    let notifyTtsQueue: (() => void) | undefined;
    const wakeTtsQueue = () => {
      const notify = notifyTtsQueue;
      notifyTtsQueue = undefined;
      notify?.();
    };

    const ttsTextIterator = (async function* () {
      while (!ttsQueueClosed || ttsQueue.length > 0) {
        const next = ttsQueue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>(resolve => {
          notifyTtsQueue = resolve;
        });
      }
    })();

    let totalBytesSent = 0;
    const ttsPromise = session.ttsClient.streamTTS(
      session.voiceConfig,
      ttsTextIterator,
      async ttsChunk => {
        if (session.turnState !== 'agent-speaking' || session.audioGeneration !== myGeneration) {
          return;
        }
        if (ttsChunk.audio?.length > 0) {
          totalBytesSent += ttsChunk.audio.length;
          this.sendAudioToTwilio(session, ttsChunk.audio);
        }
      },
      error => {
        this.logger.error(`❌ TTS chunk error for ${session.callSid}:`, error);
      },
    );
    // The translation loop below can stay suspended on an `await localizeFlowAgentSpeechChunk(...)`
    // call for a while; if ttsPromise rejects during that window (e.g. abort() closes the socket
    // on a barge-in) before the `await ttsPromise.catch(...)` further down ever runs, it would be
    // an unhandled rejection — which crashes the whole process on this Node version. Attach a
    // handler immediately; the real error is still observed via the awaited `ttsPromise` below.
    ttsPromise.catch(() => {
      /* handled below via `await ttsPromise.catch(...)` */
    });

    try {
      for (const englishChunk of englishChunks) {
        if (session.turnState !== 'agent-speaking' || session.audioGeneration !== myGeneration) {
          break;
        }
        const translated = await localizeFlowAgentSpeechChunk(this.openaiClient, {
          fullText,
          chunkText: englishChunk,
          targetLanguageIso6391: targetLang,
          precedingTranslatedChunks: translatedChunks,
        });
        translatedChunks.push(translated);
        if (session.turnState !== 'agent-speaking' || session.audioGeneration !== myGeneration) {
          break;
        }
        ttsQueue.push(translated);
        wakeTtsQueue();
      }
    } finally {
      ttsQueueClosed = true;
      wakeTtsQueue();
      await ttsPromise.catch((err: unknown) => {
        this.logger.error(`❌ TTS stream failed for ${session.callSid}:`, err);
      });
    }

    this.flushTwilioPendingAudio(session);

    const finalText = translatedChunks.join(' ').trim() || fullText;
    if (finalText !== fullText) {
      this.logger.log(
        `🌐 Localized agent line pipelined (${targetLang}): "${fullText.substring(0, 50)}..." → "${finalText.substring(0, 50)}..."`,
      );
    }
    if (session.turnState === 'agent-speaking' && session.audioGeneration === myGeneration) {
      this.completeSpeakTextAfterAudio(session, finalText, totalBytesSent, myGeneration);
    }
    return finalText;
  }

  private buildVoiceConfig(
    callState: {
      voiceId?: string;
      metadata?: Record<string, unknown>;
    },
    languageOverride?: string,
  ): TTSConfig {
    const lang = languageOverride ?? (callState.metadata?.language as string | undefined) ?? 'en';
    const canon = metadataToCanonicalIso6391(lang);
    const defaults = this.voiceClientFactory.getDefaultVoiceConfig(canon);
    const fromCall = callState.voiceId || callState.metadata?.voiceId;
    const raw =
      fromCall != null && String(fromCall) !== '' && String(fromCall) !== 'default'
        ? String(fromCall)
        : undefined;

    let voiceId = raw ?? defaults.voiceId;
    if (
      this.voiceClientFactory.isLocalMode() &&
      voiceId &&
      ElevenLabsVoiceBridgeService.looksLikeElevenLabsVoiceId(voiceId)
    ) {
      voiceId = defaults.voiceId;
      this.logger.log(
        `🎤 Local TTS: ignoring ElevenLabs voice id; using Chatterbox default voice path (ElevenLabs used if Chatterbox is down)`,
      );
    }

    const fallbackVoiceId = voiceId !== defaults.voiceId ? defaults.voiceId : undefined;

    return {
      ...defaults,
      voiceId,
      fallbackVoiceId,
      language: defaults.language ?? canon,
    };
  }

  /**
   * Open the TTS WebSocket for an outbound call while it's still ringing, so the greeting doesn't
   * pay the ElevenLabs connect+TLS handshake after the user answers (the handshake instead of being
   * hidden takes the same ~1s that {@link completeSpeakTextAfterAudio} already hides for turn 2+ via
   * `prewarm`, which never runs for the very first line of a call since there is no prior turn).
   * Best-effort and fire-and-forget: `start()` falls back to a fresh client if nothing was claimed.
   */
  prewarmOutboundTts(
    callSid: string,
    callState: { voiceId?: string; metadata?: Record<string, unknown> },
  ): void {
    if (!this.voiceClientFactory.isCloudMode()) return; // only ElevenLabs's WS path benefits from prewarm
    try {
      const voiceConfig = this.buildVoiceConfig(callState);
      const client = this.voiceClientFactory.createTTSClient();
      client.prewarm?.(voiceConfig);
      this.discardPrewarmedTtsClient(callSid); // clear any stale entry from a prior attempt for this callSid
      this.prewarmedTtsClients.set(callSid, client);
      this.prewarmedTtsExpiry.set(
        callSid,
        setTimeout(() => {
          this.logger.debug(`🌤️ Prewarmed TTS for ${callSid} expired unclaimed — discarding`);
          this.discardPrewarmedTtsClient(callSid);
        }, ElevenLabsVoiceBridgeService.PREWARM_TTS_EXPIRY_MS),
      );
      this.logger.log(`🌤️ Pre-warming TTS (voice=${voiceConfig.voiceId}) for outbound ${callSid}`);
    } catch (err) {
      this.logger.warn(
        `⚠️ TTS prewarm failed for ${callSid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Take ownership of a prewarmed TTS client for this call, if one exists, clearing its expiry. */
  private claimPrewarmedTtsClient(callSid: string): ITTSClient | undefined {
    const client = this.prewarmedTtsClients.get(callSid);
    if (!client) return undefined;
    this.prewarmedTtsClients.delete(callSid);
    const timeoutId = this.prewarmedTtsExpiry.get(callSid);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.prewarmedTtsExpiry.delete(callSid);
    }
    return client;
  }

  /** Discard an unclaimed prewarmed TTS client (e.g. call never answered) and close its socket. */
  private discardPrewarmedTtsClient(callSid: string): void {
    const timeoutId = this.prewarmedTtsExpiry.get(callSid);
    if (timeoutId) clearTimeout(timeoutId);
    this.prewarmedTtsExpiry.delete(callSid);
    const client = this.prewarmedTtsClients.get(callSid);
    if (client) {
      this.prewarmedTtsClients.delete(callSid);
      client.abort();
    }
  }

  /**
   * Called ONCE per call when Twilio sends `start`
   * @param options.onTtsStart - Called when AI starts speaking (gateway should pause processing user audio)
   * @param options.onTtsEnd - Called when AI finishes speaking (gateway can resume processing user audio)
   * @param options.onInterruption - Called when user interrupted agent (gateway should allow next final transcript)
   */
  async start(
    callSid: string,
    streamSid: string,
    twilioWs: WebSocket,
    options?: {
      onTtsStart?: (sid: string) => void;
      onTtsEnd?: (sid: string) => void;
      onInterruption?: (sid: string) => void;
      /** Local stdin chat: skip Twilio handlers, no phone/TTS cost */
      terminalTextOnly?: boolean;
      onTerminalSessionEnd?: () => void;
    },
  ) {
    const terminalTextOnly = options?.terminalTextOnly === true;
    this.logger.log(
      `${terminalTextOnly ? '🖥️' : '🚀'} START called for ${callSid}, streamSid=${streamSid}${terminalTextOnly ? ' (terminal text)' : ''}`,
    );

    const callState = this.callStateService.findOne(callSid);
    if (!callState) {
      this.logger.error(`❌ No CallState for ${callSid} - cannot start session`);
      return;
    }

    callState.metadata ??= {};
    this.logger.log(`✅ CallState found for ${callSid}`);

    const isFlowCall = !!(
      callState.metadata?.flow ||
      ((callState.metadata?.flowCompanyId || callState.companyId) && callState.metadata?.flowId)
    );

    const voiceConfig = this.buildVoiceConfig(callState);
    this.logger.log(
      `🎤 Voice (${this.voiceClientFactory.getMode()}): ${voiceConfig.voiceId} for ${callSid}`,
    );

    const rawSensitivity = callState.metadata?.interruptionSensitivity;
    const interruptionSensitivity = typeof rawSensitivity === 'number' ? rawSensitivity : undefined;
    if (interruptionSensitivity != null) {
      this.logger.log(
        `🎚️ Agent interruption sensitivity: ${interruptionSensitivity} for ${callSid}`,
      );
    }

    const prewarmedTtsClient = this.claimPrewarmedTtsClient(callSid);
    this.logger.log(
      prewarmedTtsClient
        ? `🌤️ Reusing pre-warmed TTS connection for ${callSid} — greeting skips the connect handshake`
        : `🧊 No pre-warmed TTS connection for ${callSid} — greeting will pay the connect handshake`,
    );

    const session: CallSession = {
      twilioWs,
      streamSid,
      callSid,
      ready: true,
      conversationHistory: [],
      isProcessing: false,
      ttsClient: prewarmedTtsClient ?? this.voiceClientFactory.createTTSClient(),
      openaiClient: this.openaiClient,
      voiceConfig,
      isFlowCall,
      turnState: 'idle',
      recentTranscripts: new Map(),
      onTtsStart: options?.onTtsStart,
      onTtsEnd: options?.onTtsEnd,
      onInterruption: options?.onInterruption,
      interruptionSensitivity,
      turnContext: {
        isWaitingForUser: false,
        lastUserActivity: Date.now(),
        partialTranscript: '',
        isProcessingPartial: false,
      },
      agentGlobalPreamble: buildAgentGlobalPreambleFromMetadata(callState.metadata),
      agentDisplayName: resolveAgentDisplayNameFromMetadata(callState.metadata),
      conversationFlowMode: normalizeConversationFlowMode(callState.metadata?.conversationFlowMode),
      isOutboundCall: callState.metadata?.callType === 'outbound',
      terminalTextOnly,
      onTerminalSessionEnd: options?.onTerminalSessionEnd,
    };

    this.sessions.set(callSid, session);
    this.logger.log(`💾 Session stored for ${callSid}. Total sessions: ${this.sessions.size}`);

    // Initialize based on call type
    if (isFlowCall) {
      await this.initializeFlowCall(session, callState);
    } else {
      await this.initializeAIConversation(session, callState);
    }

    // Audio ingress/STT is always owned by VoiceMediaGateway (externalMediaHandler), which wires
    // the real STT client and calls processPartialTranscript/processUserTranscript/handleSilence
    // directly. There used to be a second, dead-end audio path here (setupTwilioHandlers →
    // handleTwilioMedia → streamAudioToSTT, which was never actually wired to any STT service) —
    // it was removed because leaving it in place meant any future caller of start() that omitted
    // externalMediaHandler would silently attach a second competing WebSocket 'message' listener
    // that swallowed audio into a no-op stub instead of the real STT pipeline.

    // Send silence to Twilio when idle so the media stream is not closed (Twilio may timeout after ~5–30s of no outgoing media)
    // this.startSilenceKeepalive(session);

    // Handle end-after-first-message for information/reminder calls
    const endAfterFirst = !!callState.metadata?.endCallAfterFirstMessage;
    session.endCallAfterFirstMessage = endAfterFirst;
    session.firstMessageEndScheduled = false;

    if (endAfterFirst) {
      this.logger.log(
        `⏱️ Information call: will end ${callSid} after first message (fallback in ${this.END_CALL_FALLBACK_MS / 1000}s)`,
      );
      const timeoutId = setTimeout(() => {
        this.performEndCall(callSid, 'fallback_after_first_message');
      }, this.END_CALL_FALLBACK_MS);
      session.endCallTimeoutId = timeoutId;
    }

    if (!terminalTextOnly) {
      const cap = ElevenLabsVoiceBridgeService.MAX_CALL_DURATION_MS;
      const fromMeta = callState.metadata?.maxCallDurationMs;
      const raw = typeof fromMeta === 'number' && fromMeta > 0 ? fromMeta : cap;
      const effectiveMaxMs = Math.min(raw, cap);
      this.logger.log(
        `⏱️ Max call duration: ${effectiveMaxMs / 1000}s (hard cap ${cap / 1000}s) for ${callSid}`,
      );
      session.maxCallDurationTimeoutId = setTimeout(() => {
        this.logger.log(`⏱️ Max call duration reached for ${callSid}, ending call`);
        this.performEndCall(callSid, 'max_duration_reached');
      }, effectiveMaxMs);
    } else {
      this.logger.log(`⏱️ Terminal REPL: no max-duration hangup for ${callSid}`);
    }
  }

  /**
   * Initialize AI-driven conversation
   */
  private async initializeAIConversation(session: CallSession, callState: any) {
    const taskPrompt = callState.script?.trim() || 'You are a helpful phone assistant.';
    const language = callState.metadata?.language ?? 'en';
    session.language = language;
    const agentBlock = session.agentGlobalPreamble?.trim();
    session.systemPromptAfterLanguageInstruction = [
      agentBlock,
      taskPrompt,
      this.AGENT_BEHAVIOR_GUIDELINES,
    ]
      .filter(Boolean)
      .join('\n\n');
    const fullPrompt = [
      languageInstructionForLlmPrompt(language),
      session.systemPromptAfterLanguageInstruction,
    ]
      .filter(Boolean)
      .join('\n\n');

    session.conversationHistory = [
      {
        role: 'system',
        content: fullPrompt,
      },
    ];

    const scriptDirection = callState.metadata?.callType === 'outbound' ? 'outbound' : 'inbound';
    const firstMessageRaw = pickScriptFirstMessage(callState.metadata?.firstMessage, language, {
      direction: scriptDirection,
    });
    const firstMessage = this.applyAgentIntroductionIfNeeded(firstMessageRaw, session);

    if (firstMessage) {
      session.conversationHistory.push({
        role: 'assistant',
        content: firstMessage,
      });
      await this.speakText(session, firstMessage);
    } else if (session.agentDisplayName?.trim()) {
      const intro = this.buildAgentSelfIntroduction(
        session.agentDisplayName.trim(),
        session.language,
      );
      session.conversationHistory.push({
        role: 'assistant',
        content: intro,
      });
      await this.speakText(session, intro);
    }
  }

  /**
   * Initialize flow-based call
   */
  private async initializeFlowCall(session: CallSession, callState: any) {
    const initialLang = metadataToCanonicalIso6391(
      (callState.metadata?.language as string | undefined) ?? 'en',
    );
    this.setConversationLanguage(session, initialLang);

    let flowConfig: any;
    let firstMessage: string;

    if (callState.metadata?.flow) {
      this.logger.log(`🏗️ Building flow config from metadata for ${session.callSid}`);
      const built = this.buildFlowConfigFromMetadata(callState);
      flowConfig = built;
      firstMessage = built.firstMessage;
      session.currentFlow = built.flow;
      session.flowState = built.initialState;
      session.flowState.conversationLanguage = initialLang;
      session.currentNodeId = built.initialState.currentNode;
    } else if (
      (callState.metadata?.flowCompanyId || callState.companyId) &&
      callState.metadata?.flowId &&
      this.flowsService
    ) {
      this.logger.log(`🏗️ Loading flow from service for ${session.callSid}`);
      try {
        const loaded = await this.loadFlowFromService(callState, callState.metadata.flowId);
        flowConfig = loaded;
        firstMessage = loaded.firstMessage;
        session.currentFlow = loaded.flow;
        session.flowState = loaded.initialState;
        session.flowState.conversationLanguage = initialLang;
        session.currentNodeId = loaded.initialState.currentNode;
      } catch (loadErr) {
        this.logger.error(
          `❌ Failed to load flow for ${session.callSid} (flowId=${callState.metadata?.flowId}):`,
          loadErr,
        );
        if (callState.metadata?.flow) {
          this.logger.log(`🔄 Fallback: using metadata.flow for ${session.callSid}`);
          const built = this.buildFlowConfigFromMetadata(callState);
          flowConfig = built;
          firstMessage = built.firstMessage;
          session.currentFlow = built.flow;
          session.flowState = built.initialState;
          session.currentNodeId = built.initialState.currentNode;
        } else {
          session.isFlowCall = false;
          session.onTtsEnd?.(session.callSid);
          await this.initializeAIConversation(session, callState);
          return;
        }
      }
    } else {
      this.logger.error(
        `❌ Flow call but no flow available for ${session.callSid} (need metadata.flow or metadata.flowId + flowCompanyId/companyId)`,
      );
      session.isFlowCall = false;
      session.onTtsEnd?.(session.callSid);
      await this.initializeAIConversation(session, callState);
      return;
    }

    // Send first message: template, or say.prompt on start node, or fallback. Always call onTtsEnd if we don't speak so gateway can accept user audio.
    const startNode = session.currentFlow
      ? getNode(session.currentFlow, session.flowState?.currentNode ?? '')
      : null;
    try {
      if (firstMessage) {
        const opening = this.applyAgentIntroductionIfNeeded(firstMessage, session);
        const toSpeak = await this.speakFlowResponse(session, opening);
        this.appendFlowAgentHistory(session, toSpeak);
        this.patchLastAgentHistoryText(session, toSpeak);
      } else if (getSayPrompt(startNode)) {
        await this.handleFlowPromptNode(
          session,
          getSayPrompt(startNode)!,
          session.flowState.slots,
          {
            addCallStartIntroduction: true,
          },
        );
      } else if (this.flowRuntime && session.currentFlow) {
        const fallbackFirst = this.flowRuntime.buildFirstMessage(
          session.currentFlow,
          session.flowState.slots,
          session.language,
          { treatAsOutbound: session.isOutboundCall === true },
        );
        if (fallbackFirst) {
          const opening = this.applyAgentIntroductionIfNeeded(fallbackFirst, session);
          const toSpeak = await this.speakFlowResponse(session, opening);
          this.appendFlowAgentHistory(session, toSpeak);
          this.patchLastAgentHistoryText(session, toSpeak);
        } else {
          session.onTtsEnd?.(session.callSid);
        }
      } else if (session.agentDisplayName?.trim()) {
        const introOnly = this.buildAgentSelfIntroduction(
          session.agentDisplayName.trim(),
          session.language,
        );
        await this.speakText(session, introOnly);
        this.appendFlowAgentHistory(session, introOnly);
      } else {
        session.onTtsEnd?.(session.callSid);
      }
    } catch (err) {
      this.logger.error(`❌ Flow first message failed for ${session.callSid}:`, err);
      session.onTtsEnd?.(session.callSid);
    }
    // if (startNode?.listen) {
    //   this.scheduleNoResponseRephrase(session, session.callSid);
    // }
  }

  private buildAgentSelfIntroduction(name: string, language?: string): string {
    const lang = metadataToCanonicalIso6391(language);
    switch (lang) {
      case 'no':
        return `Hei, dette er ${name}.`;
      case 'nl':
        return `Hallo, u spreekt met ${name}.`;
      case 'de':
        return `Guten Tag, hier spricht ${name}.`;
      case 'es':
        return `Hola, habla ${name}.`;
      case 'fr':
        return `Bonjour, c'est ${name}.`;
      default:
        return `Hi, this is ${name}.`;
    }
  }

  /** Outbound / proactive call — sounds natural when we dialed the callee. */
  private buildAgentOutboundIntroduction(name: string, language?: string): string {
    const lang = metadataToCanonicalIso6391(language);
    switch (lang) {
      case 'no':
        return `Hei, det er ${name} som ringer.`;
      case 'nl':
        return `Goedemiddag! U spreekt met ${name}.`;
      case 'de':
        return `Guten Tag! Hier spricht ${name}.`;
      case 'es':
        return `Hola, habla ${name}.`;
      case 'fr':
        return `Bonjour, c'est ${name} à l'appareil.`;
      default:
        return `Hi, this is ${name} calling.`;
    }
  }

  /** Fixed (not LLM-generated) reply to a bare first-turn "Hello?" — see `isGenericPhoneGreetingOnly`
   * and its call site. Never repeats the agent's own introduction, since it's not derived from the
   * LLM at all. */
  private buildFirstTurnGreetingAcknowledgement(language?: string): string {
    const lang = metadataToCanonicalIso6391(language);
    switch (lang) {
      case 'no':
        return 'Ja, jeg er her. Hvordan kan jeg hjelpe deg?';
      case 'nl':
        return 'Ja, ik ben er. Hoe kan ik u helpen?';
      case 'de':
        return 'Ja, ich bin da. Wie kann ich Ihnen helfen?';
      case 'es':
        return '¡Sí, aquí estoy! ¿En qué puedo ayudarle?';
      case 'fr':
        return 'Oui, je suis là. Comment puis-je vous aider ?';
      default:
        return "Yes, I'm here — how can I help you?";
    }
  }

  private async speakFirstTurnGreetingAcknowledgement(session: CallSession): Promise<void> {
    const ack = this.buildFirstTurnGreetingAcknowledgement(
      this.getActiveConversationLanguage(session),
    );
    if (session.isFlowCall && session.flowState) {
      session.flowState.history.push({ role: 'agent', text: ack, at: new Date().toISOString() });
    } else {
      session.conversationHistory.push({ role: 'assistant', content: ack });
    }
    await this.speakText(session, ack);
  }

  /**
   * Rotating filler pool spoken immediately when a tool-calling flow turn actually starts calling a
   * tool (see `onBeforeToolExecution` in `ConversationFlowToolExecutorService.runToolAugmentedChat`),
   * so the caller never sits in silence across a (possibly multi-round-trip) tool chain. Kept short
   * and generic — this is a latency bridge, not content. Hardcoded for the languages this file
   * already special-cases elsewhere (see `buildAgentSelfIntroduction`); any other active language
   * falls back through the existing `prepareAgentSpeech` localization path.
   */
  private static readonly TOOL_CALL_FILLERS: Record<string, string[]> = {
    en: [
      'One moment, let me check that.',
      'Let me look that up for you.',
      'Give me just a second.',
    ],
    no: ['Et øyeblikk, jeg sjekker det.', 'La meg se på det for deg.'],
    nl: ['Een moment, ik controleer dat.', 'Ik zoek dat even voor u op.'],
    de: ['Einen Moment, ich schaue das nach.', 'Ich sehe kurz nach.'],
    es: ['Un momento, lo reviso.', 'Déjeme revisar eso.'],
    fr: ['Un instant, je vérifie ça.', 'Laissez-moi vérifier cela.'],
  };

  /** Picks a tool-call filler phrase, avoiding an immediate repeat of the last one spoken this call. */
  private async pickToolCallFillerSpeech(session: CallSession): Promise<string> {
    const lang = this.getActiveConversationLanguage(session);
    const hardcoded = ElevenLabsVoiceBridgeService.TOOL_CALL_FILLERS[lang];
    const pool = hardcoded ?? ElevenLabsVoiceBridgeService.TOOL_CALL_FILLERS.en;
    const choices = pool.filter(p => p !== session.lastFillerPhrase);
    const source = choices.length ? choices : pool;
    const englishOrLocalPick = source[Math.floor(Math.random() * source.length)];

    if (hardcoded) {
      session.lastFillerPhrase = englishOrLocalPick;
      return englishOrLocalPick;
    }
    // No hardcoded pool for this language — localize through the same pipeline used for every
    // other flow-script line in a non-English call.
    const localized = await this.prepareAgentSpeech(session, englishOrLocalPick, {
      fromFlowScript: true,
    });
    session.lastFillerPhrase = localized;
    return localized;
  }

  /**
   * Speaks an immediate filler in parallel with an in-flight tool call. Fire-and-forget by design
   * (called from `onBeforeToolExecution`, a sync callback) — failures are logged and swallowed so a
   * filler TTS hiccup never breaks the actual tool-loop turn.
   */
  private async speakToolCallFiller(session: CallSession): Promise<void> {
    if (session.userEndCallRequested || session.agentEndCallSignaled || session.terminalTextOnly) {
      return;
    }
    try {
      const filler = await this.pickToolCallFillerSpeech(session);
      await this.speakFlowResponse(session, filler);
    } catch (err) {
      this.logger.debug(
        `⏭️ Tool-call filler speech failed for ${session.callSid} (non-fatal):`,
        err,
      );
    }
  }

  private applyAgentIntroductionIfNeeded(
    firstMessage: string | undefined,
    session: CallSession,
  ): string {
    const message = firstMessage?.trim() ?? '';
    if (message === '') return '';
    const name = session.agentDisplayName?.trim();
    if (!name) return message;

    // Avoid repeating introductions when script/flow already introduces the agent — checked
    // across every language we have intro templates for, not just English/Norwegian, so a
    // self-introducing script in any of these languages doesn't get a mismatched-language intro
    // glued on in front of it (e.g. an English "Hi, this is X calling." before an all-Dutch script).
    const lower = message.toLowerCase();
    const nameLower = name.toLowerCase();
    const alreadyIntroduced =
      // English
      lower.includes(`this is ${nameLower}`) ||
      lower.includes(`${nameLower} calling`) ||
      lower.includes(`i am ${nameLower}`) ||
      lower.includes(`my name is ${nameLower}`) ||
      // Norwegian
      lower.includes(`dette er ${nameLower}`) ||
      lower.includes(`det er ${nameLower}`) ||
      lower.includes(`jeg heter ${nameLower}`) ||
      // Dutch
      lower.includes(`u spreekt met ${nameLower}`) ||
      lower.includes(`dit is ${nameLower}`) ||
      lower.includes(`hier is ${nameLower}`) ||
      lower.includes(`mijn naam is ${nameLower}`) ||
      // German
      lower.includes(`hier spricht ${nameLower}`) ||
      lower.includes(`hier ist ${nameLower}`) ||
      lower.includes(`mein name ist ${nameLower}`) ||
      lower.includes(`ich bin ${nameLower}`) ||
      // Spanish
      lower.includes(`habla ${nameLower}`) ||
      lower.includes(`soy ${nameLower}`) ||
      lower.includes(`mi nombre es ${nameLower}`) ||
      // French
      lower.includes(`c'est ${nameLower}`) ||
      lower.includes(`je suis ${nameLower}`) ||
      lower.includes(`ici c'est ${nameLower}`);
    if (alreadyIntroduced) return message;

    const intro = session.isOutboundCall
      ? this.buildAgentOutboundIntroduction(name, session.language)
      : this.buildAgentSelfIntroduction(name, session.language);
    const body = stripLeadingOverlapForMergedAgentIntro(message);
    return `${intro} ${body}`.replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * Record agent speech for the persisted transcript (flow `history` or script `conversationHistory`).
   * Skips when the last agent turn already matches (avoids duplicates when the runtime pre-inserted the line).
   */
  private appendFlowAgentHistory(session: CallSession, spoken: string): void {
    const text = spoken.trim();
    if (!text) return;

    if (session.isFlowCall && session.flowState) {
      const hist = session.flowState.history as { role: string; text?: string; at?: string }[];
      const last = hist[hist.length - 1];
      if (last?.role === 'agent' && (last.text ?? '').trim() === text) return;
      hist.push({
        role: 'agent',
        text,
        at: new Date().toISOString(),
      });
      return;
    }

    const msgs = session.conversationHistory;
    const last = msgs[msgs.length - 1];
    if (last?.role === 'assistant' && last.content.trim() === text) return;
    msgs.push({
      role: 'assistant',
      content: text,
      timestamp: new Date(),
    });
  }

  private buildTranscriptTurnsFromSession(session: CallSession): CallTranscriptTurn[] {
    if (session.isFlowCall && session.flowState?.history?.length) {
      return (session.flowState.history as { role: string; text?: string; at?: string }[])
        .filter(h => h.role === 'user' || h.role === 'agent')
        .map(
          (h): CallTranscriptTurn => ({
            role: (h.role === 'user' ? 'user' : 'agent') as CallTranscriptRole,
            text: (h.text ?? '').trim(),
            at: typeof h.at === 'string' ? h.at : undefined,
          }),
        )
        .filter(t => t.text.length > 0);
    }
    return session.conversationHistory
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m): CallTranscriptTurn => {
        const ts = (m as { timestamp?: Date }).timestamp;
        return {
          role: (m.role === 'user' ? 'user' : 'agent') as CallTranscriptRole,
          text: m.content.trim(),
          at: ts instanceof Date ? ts.toISOString() : undefined,
        };
      })
      .filter(t => t.text.length > 0);
  }

  private persistCallTranscriptToRecord(callSid: string, session: CallSession): void {
    const turns = this.buildTranscriptTurnsFromSession(session);
    if (turns.length === 0) return;
    void this.callRecordService.setConversationTranscript(callSid, turns).catch((err: unknown) => {
      this.logger.error(`Failed to persist conversation transcript for ${callSid}:`, err);
    });
  }

  // Legacy dead-end audio path removed here (setupTwilioHandlers → handleTwilioMedia →
  // streamAudioToSTT → finalizeUserUtterance/detectSpeechEnergy). It attached its own WebSocket
  // 'message' listener but streamAudioToSTT was never wired to any STT service (empty stub) and
  // finalizeUserUtterance just dropped the buffered audio — it was unreachable dead code today
  // (VoiceMediaGateway is the only real audio path, see initializeSTT there), but stayed
  // dangerous: any future caller of start() that didn't route through the gateway would silently
  // attach a second competing 'message' listener that swallowed audio into that stub instead of
  // the real STT pipeline. Real-time audio ingress/STT lives entirely in VoiceMediaGateway now.

  /**
   * Process user transcript — never block, always process.
   */
  async processUserTranscript(callSid: string, transcript: string, sttDetectedLanguage?: string) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    // Once the call-end has been signaled (goodbye scheduled / hangup pending), stop starting new
    // flow turns. Otherwise late/echo transcripts that arrive in the goodbye buffer window
    // re-trigger the end node, restarting the whole TTS connect-and-translate sequence on top of
    // the one already in flight — by the time it finishes, the scheduled hangup has already torn
    // the session down and the (correctly generated) audio never reaches the caller.
    if (session.userEndCallRequested || session.agentEndCallSignaled) {
      this.logger.debug(`⏭️ Ignoring transcript — call end already signaled for ${callSid}`);
      return;
    }

    const originalTranscript = normalizeSttTranscript(transcript);
    if (!originalTranscript) return;

    // Stale echo fragment: STT/VAD sometimes splits one spoken utterance into two finals, with the
    // trailing fragment's final commit arriving seconds after the first (already-consumed) one —
    // by which point the flow has moved to a different node. Treat it as noise rather than a new
    // turn, or it can re-trigger node logic (e.g. "is the user done?") using leftover words from a
    // turn that already finished, ending the call before the user actually replies.
    const lastConsumed = session.lastConsumedTranscript;
    if (
      lastConsumed &&
      Date.now() - lastConsumed.at <= 8000 &&
      originalTranscript.length <= 20 &&
      originalTranscript.length < lastConsumed.text.length &&
      lastConsumed.text.toLowerCase().endsWith(originalTranscript.toLowerCase()) &&
      (session.isFlowCall ? session.flowState?.currentNode !== lastConsumed.nodeId : true)
    ) {
      this.logger.debug(
        `⏭️ Stale echo fragment ignored for ${callSid}: "${originalTranscript}" (tail of already-processed "${lastConsumed.text}")`,
      );
      return;
    }

    // Lightweight adaptive turn-taking: hold a final transcript that trails off mid-thought
    // ("...and", "so I need...") briefly instead of immediately firing a full agent turn on a
    // fragment — VAD's own fixed silence threshold has no notion of whether the sentence sounds
    // finished. Never applies while the agent is speaking (barge-in must always be immediate) or
    // outside English (the heuristic isn't tuned for other languages yet).
    if (session.turnState !== 'agent-speaking') {
      if (session.pendingIncompleteUtterance) {
        // Another fragment already being held — this is very likely its continuation. Merge
        // instead of starting a second, independent turn for what's really one thought.
        const merged = `${session.pendingIncompleteUtterance.text} ${originalTranscript}`.trim();
        this.clearPendingIncompleteUtteranceHold(session);
        await this.continueProcessingUserTranscript(session, callSid, merged, sttDetectedLanguage);
        return;
      }

      if (
        this.getActiveConversationLanguage(session) === 'en' &&
        looksLikeIncompleteUtterance(originalTranscript)
      ) {
        this.logger.debug(
          `⏳ Holding likely-incomplete utterance for ${callSid}: "${originalTranscript}"`,
        );
        session.pendingIncompleteUtterance = {
          text: originalTranscript,
          timeoutId: setTimeout(() => {
            const pending = session.pendingIncompleteUtterance;
            session.pendingIncompleteUtterance = undefined;
            if (!pending || !this.sessions.has(callSid)) return;
            this.continueProcessingUserTranscript(
              session,
              callSid,
              pending.text,
              sttDetectedLanguage,
            ).catch((err: unknown) => {
              this.logger.error(`❌ Deferred transcript processing failed for ${callSid}:`, err);
            });
          }, this.INCOMPLETE_UTTERANCE_HOLD_MS),
        };
        return;
      }
    }

    await this.continueProcessingUserTranscript(
      session,
      callSid,
      originalTranscript,
      sttDetectedLanguage,
    );
  }

  /**
   * Continues `processUserTranscript`'s pipeline (language interpretation onward) for a transcript
   * that's either ready immediately or was briefly held/merged by the incomplete-utterance hold
   * above. `originalTranscript` here is already the final (possibly merged) text for this turn.
   */
  private async continueProcessingUserTranscript(
    session: CallSession,
    callSid: string,
    originalTranscript: string,
    sttDetectedLanguage?: string,
  ): Promise<void> {
    const wasAgentSpeaking = session.turnState === 'agent-speaking';
    if (wasAgentSpeaking) {
      this.logger.warn(`⚠️ User spoke while agent was speaking — barge-in for ${callSid}`);
      this.handleInterruption(callSid, originalTranscript);
    }
    let workingTranscript = originalTranscript;

    // Language interpretation
    if (this.voiceClientFactory.isSttMultilingualEnabled()) {
      // const callState = this.callStateService.findOne(callSid);
      const captureSlot =
        session.isFlowCall && session.currentFlow
          ? getListen(getNode(session.currentFlow, session.currentNodeId ?? ''))?.capture_slot
          : undefined;
      const slotDef =
        captureSlot && session.currentFlow
          ? getFlowSlotDefinition(session.currentFlow, captureSlot)
          : undefined;
      // const agentContext = session.isFlowCall
      //   ? session.flowState?.history?.filter((h: { role: string }) => h.role === 'agent')?.text
      //   : session.conversationHistory.filter(m => m.role === 'assistant').pop()?.content;
      const agentContext = session.isFlowCall
        ? session.flowState?.history
            ?.filter((h: { role: string; text?: string }) => h.role === 'agent')
            ?.pop()?.text
        : session.conversationHistory.filter(m => m.role === 'assistant').pop()?.content;

      const interpretation = await interpretUserUtterance(this.openaiClient, {
        transcript: originalTranscript,
        sttDetectedLanguage,
        agentLanguage: session.language ?? 'en',
        agentContext: typeof agentContext === 'string' ? agentContext : undefined,
        menuHint: formatSlotDefForLlm(slotDef),
      });
      session.lastUtteranceInterpretation = interpretation;
      const switchResult = this.applyConversationLanguageSwitch(session, {
        explicitRequestLang: interpretation.explicitLanguageRequestIso6391 ?? undefined,
        detectedLang: interpretation.replyLanguageIso6391,
        transcript: originalTranscript,
      });
      if (switchResult.kind === 'explicit' && switchResult.newLang) {
        session.pendingLanguageAckLang = switchResult.newLang;
      }
      workingTranscript = interpretation.workingText || originalTranscript;

      if (interpretation.originalText !== interpretation.workingText) {
        this.logger.log(
          `🌐 Interpreted (${interpretation.detectedLanguageIso6391}): "${interpretation.originalText}" → "${interpretation.workingText}"`,
        );
      }
    } else if (sttDetectedLanguage) {
      this.applyConversationLanguageSwitch(session, {
        detectedLang: sttDetectedLanguage,
        transcript: originalTranscript,
      });
    }

    // Check if we're in cool-down period (agent just spoke)
    if (session.conversationState?.isInCoolDown) {
      const timeUntilReady = session.conversationState.expectedResponseTime - Date.now();
      if (timeUntilReady > 0) {
        this.logger.log(
          `⏳ Ignoring input "${workingTranscript}" - cool-down active (${timeUntilReady}ms remaining)`,
        );
        return;
      }
    }

    // If agent still speaking, force interruption
    if (session.turnState === 'agent-speaking') {
      this.logger.warn(`⚠️ Transcript while agent speaking — forcing interruption for ${callSid}`);
      this.handleInterruption(callSid, originalTranscript);
    }

    // Check duplicate/echo (1.5s window)
    // const now = Date.now();
    // const recent = session.recentTranscripts || new Map();
    // for (const [text, time] of recent.entries()) {
    //   if (now - time > 1500) recent.delete(text);
    // }
    // if (recent.has(workingTranscript)) {
    //   this.logger.debug(`⏭️ Duplicate transcript ignored for ${callSid}`);
    //   return;
    // }
    // recent.set(workingTranscript, now);
    // session.recentTranscripts = recent;
    const now = Date.now();
    const recent = session.recentTranscripts || new Map<string, number>();

    for (const [text, time] of recent.entries()) {
      if (now - time > 1500) recent.delete(text);
    }

    const duplicateKey = workingTranscript.toLowerCase().trim();
    if (recent.has(duplicateKey)) {
      this.logger.debug(`⏭️ Duplicate transcript ignored for ${callSid}`);
      return;
    }

    recent.set(duplicateKey, now);
    session.recentTranscripts = recent;

    if (session.conversationState) {
      session.conversationState.lastUserMessageTime = now;
    }

    // Highest-priority interrupt: caller directly asking for a human, checked before anything else
    // (flow, script, or generic AI) gets a chance to process this turn — see messageImpliesUserWantsHuman.
    if (
      messageImpliesUserWantsHuman(originalTranscript) ||
      messageImpliesUserWantsHuman(workingTranscript)
    ) {
      await this.handleUserWantsHumanRequest(callSid, workingTranscript || originalTranscript);
      return;
    }

    // End call intent
    if (
      this.detectUserEndCallIntent(originalTranscript) ||
      this.detectUserEndCallIntent(workingTranscript)
    ) {
      await this.handleUserEndCallRequest(callSid);
      return;
    }

    // Noise filter (permissive)
    if (!session.terminalTextOnly && this.isLikelyNoiseOrFiller(workingTranscript, session)) {
      this.logger.debug(`⏭️ Noise/filler skipped for ${callSid}: "${workingTranscript}"`);
      return;
    }

    // First-turn generic phone-greeting ("Hello?", "Hi", ...): people often say this reflexively
    // when picking up, especially if there's any delay before/overlapping with the agent's own
    // greeting — it's not a real question. Running a full LLM turn on it tends to re-introduce the
    // agent (the LLM has little else to go on), which sounds like the greeting repeating. Give a
    // brief fixed acknowledgment instead and skip the flow/LLM turn entirely — the flow/history
    // state stays exactly where it was, still waiting for the user's actual first message.
    if (!session.hasHadFirstUserTurn) {
      session.hasHadFirstUserTurn = true;
      if (this.isGenericPhoneGreetingOnly(workingTranscript)) {
        this.logger.debug(
          `⏭️ First-turn generic greeting acknowledged without repeating intro for ${callSid}: "${workingTranscript}"`,
        );
        await this.speakFirstTurnGreetingAcknowledgement(session);
        return;
      }
    }

    // Clear reprompt block
    if (session.isFlowCall && session.lastRepromptAt != null) {
      session.lastRepromptAt = undefined;
    }

    // Post-interruption context
    const isPostInterruption =
      session.interruptionAt != null &&
      Date.now() - session.interruptionAt <= this.INTERRUPTION_GRACE_MS;
    const interruptionUtterance = session.interruptionUtterance;
    if (isPostInterruption) {
      session.interruptionAt = undefined;
      session.interruptionUtterance = undefined;
    }

    session.lastConsumedTranscript = {
      text: originalTranscript,
      at: Date.now(),
      nodeId: session.isFlowCall ? session.flowState?.currentNode : undefined,
    };

    // Process immediately — NO DELAY
    await this.processFlowTurnWithLock(
      session,
      callSid,
      workingTranscript,
      isPostInterruption,
      interruptionUtterance,
    );
  }

  /**
   * Process turn with interruptible lock.
   */
  private async processFlowTurnWithLock(
    session: CallSession,
    callSid: string,
    userTranscript: string,
    isInterruption = false,
    interruptionUtterance?: string,
  ): Promise<void> {
    // Marks the start of a new turn attempt so a background operation with no cancellation (the
    // tool-loop path in handleFlowPromptNode) can tell it was superseded once this resolves.
    session.turnSequence = (session.turnSequence ?? 0) + 1;
    if (session.processingLock) {
      if (isInterruption || session.turnState === 'agent-speaking') {
        this.logger.log(`🔄 Aborting current turn for new input on ${callSid}`);
        if (session.llmAbortController) {
          session.llmAbortController.abort();
          session.llmAbortController = undefined;
        }
        // try {
        //   await Promise.race([session.processingLock, this.delay(100)]);
        // } catch {
        //   /* ignore */
        // }
      } else {
        this.logger.debug(`🔒 Waiting for turn lock on ${callSid}`);
        await session.processingLock;
        // if (session.recentTranscripts?.has(userTranscript)) return;
      }
    }

    let resolveLock: () => void;
    session.processingLock = new Promise<void>(r => {
      resolveLock = r;
    });
    session.releaseLock = resolveLock!;

    try {
      session.isProcessing = true;
      session.turnState = 'processing-user';

      if (session.isFlowCall) {
        if (this.isNoiseOrStaticTranscript(userTranscript)) {
          this.clearPendingReprompt(session);
          this.logger.debug(`⏭️ Noise/static ignored for ${callSid}`);
          return;
        }
        this.clearPendingReprompt(session);
        await this.processFlowTurn(
          session,
          callSid,
          userTranscript,
          isInterruption,
          false,
          interruptionUtterance,
        );
      } else {
        await this.processAIConversationTurn(session, callSid, userTranscript);
      }
    } finally {
      session.isProcessing = false;
      this.releaseTurnLock(session);
    }
  }

  private releaseTurnLock(session: CallSession): void {
    if (session.releaseLock) {
      session.releaseLock();
      session.processingLock = undefined;
      session.releaseLock = undefined;
    }
  }

  private clearPendingReprompt(session: CallSession): void {
    if (session.pendingReprompt) {
      clearTimeout(session.pendingReprompt.timeoutId);
      session.pendingReprompt = undefined;
    }
  }

  private clearPendingIncompleteUtteranceHold(session: CallSession): void {
    if (session.pendingIncompleteUtterance) {
      clearTimeout(session.pendingIncompleteUtterance.timeoutId);
      session.pendingIncompleteUtterance = undefined;
    }
  }

  /**
   * Called when the deferred-reprompt timer fires. Only speaks if we're still on the same node
   * and no user turn is being processed (so we don't talk over the user).
   */
  private async fireDeferredReprompt(
    session: CallSession,
    callSid: string,
    nodeId: string,
    responseText: string,
  ): Promise<void> {
    session.pendingReprompt = undefined;
    if (!this.sessions.has(callSid)) return;
    if (session.flowState?.currentNode !== nodeId) {
      this.logger.debug(
        `⏭️ Deferred reprompt skipped for ${callSid}: node moved to ${session.flowState?.currentNode}`,
      );
      return;
    }
    if (session.isProcessing) {
      this.logger.debug(`⏭️ Deferred reprompt skipped for ${callSid}: user turn in progress`);
      return;
    }
    session.lastRepromptAt = Date.now();
    this.logger.log(`🔄 Speaking deferred reprompt for ${callSid}`);
    const toSpeak = await this.speakFlowResponse(session, responseText, true);
    this.appendFlowAgentHistory(session, toSpeak);
    this.patchLastAgentHistoryText(session, toSpeak);
  }

  /** Transcripts that are noise/static and should not trigger a flow turn or reprompt */
  private isNoiseOrStaticTranscript(transcript: string): boolean {
    const t = transcript.trim();
    if (!t) return true;
    const lower = t.toLowerCase();
    if (lower === '(static)' || lower === 'static' || t === '' || t.length <= 1) return true;
    if (/^[\s().,?-]+$/i.test(t)) return true;
    // const noiseWords = ['*static*', '*snort*', '*beep*', '*sigh*', '*laughs*'];
    // if (noiseWords.some(w => lower === w || lower.startsWith(w))) return true;
    // if (/^\*[\w\s]+\*$/.test(lower) && lower.length <= 30) return true;
    // if (/^(\*[\w]+\*\s*)+$/.test(lower)) return true;

    // Unicode replacement character (U+FFFD) is what a decoder emits for bytes that don't map to
    // valid text — a hard signal of corrupted/garbled STT output ("ਅਹ, ਅ�"), never real speech.
    if (t.includes('�')) return true;

    // STT hallucinating on background noise / a bad phone line produces short bursts that hop
    // between unrelated scripts within one utterance (e.g. "Account number" + nonsense Gurmukhi +
    // "MICR."). See countDistinctScripts() — kept out of short menu-style code-switched replies by
    // only applying to longer transcripts, where genuine code-switching is rare.
    if (t.length >= 15 && t.length <= 80 && countDistinctScripts(t) >= 3) return true;

    // ASR hallucination artifact: the same single token repeated many times (e.g. background
    // noise/silence transcribed as "अ, अ, अ, अ..."). Real speech essentially never does this,
    // regardless of script/language, so this check is language-agnostic.
    const tokens = lower.split(/[\s,.!?؟۔-]+/).filter(Boolean);
    if (tokens.length >= 4 && new Set(tokens).size === 1) return true;
    return false;
  }

  /**
   * Process AI conversation with STREAMING LLM → TTS pipeline.
   *
   * TTS starts as soon as first sentence is ready. All stages overlap.
   * Target: <700ms from user stop-speaking to first audio byte.
   */
  private async processAIConversationTurn(
    session: CallSession,
    callSid: string,
    userText: string,
  ): Promise<void> {
    this.logger.log(`🎤 User said [${callSid}]: "${userText}"`);
    const ackInstruction = this.consumePendingLanguageAckInstruction(session);
    if (ackInstruction) {
      session.conversationHistory.push({ role: 'system', content: ackInstruction });
    }
    session.conversationHistory.push({ role: 'user', content: userText });

    const abortController = new AbortController();
    session.llmAbortController = abortController;

    try {
      const openaiStream = await session.openaiClient.streamConversationChat(
        session.conversationHistory,
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.7, maxTokens: 500, signal: abortController.signal },
      );

      const sink = this.createStreamingTtsSink(session, callSid);
      let trimmedResponse: string;
      try {
        for await (const chunk of openaiStream) {
          if (abortController.signal.aborted) {
            this.logger.log(`⏹️ LLM stream aborted for ${callSid}`);
            break;
          }
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) sink.onTextDelta(content);
        }
      } finally {
        trimmedResponse = await sink.finish();
      }

      if (trimmedResponse) {
        // Already spoken (streamed sentence-by-sentence above) — this can only arm a transfer for
        // after the reply finishes, not rewrite what was just said. See detectNonFlowHandoffTrigger.
        this.detectNonFlowHandoffTrigger(session, trimmedResponse);
        session.conversationHistory.push({ role: 'assistant', content: trimmedResponse });
        session.lastAgentResponse = trimmedResponse;

        const scriptContext =
          session.conversationHistory.find(m => m.role === 'system')?.content?.slice(0, 2000) ?? '';
        this.runAsyncResponseVerification(callSid, {
          generatedResponse: trimmedResponse,
          userInput: userText,
          nodeContext: scriptContext,
          language: session.language ?? 'en',
          generationType: 'script_response',
          recentTurns: session.conversationHistory
            .slice(-8)
            .filter(m => m.role !== 'system')
            .map(m => ({
              role: m.role === 'user' ? ('user' as const) : ('agent' as const),
              text: m.content,
            })),
        });
      }

      if (session.turnState === 'agent-speaking' && session.audioGeneration === sink.generation) {
        session.turnState = 'waiting-for-user';
        session.onTtsEnd?.(callSid);
        this.completeSpeakTextAfterAudio(session, trimmedResponse, 0, sink.generation);
      }
    } catch (err) {
      this.logger.error(`❌ Streaming turn error for ${callSid}:`, err);
      session.turnState = 'waiting-for-user';
      session.onTtsEnd?.(callSid);
    } finally {
      session.llmAbortController = undefined;
    }
  }

  /**
   * Shared sentence/comma-boundary flush → TTS streaming queue, used by every conversational turn
   * that streams (non-flow turns and, for non-tool-loop nodes, flow turns — see
   * `handleFlowPromptNode`). Feed raw LLM content deltas via `onTextDelta` as they arrive; call
   * `finish()` once the LLM stream ends to flush the remaining buffer, close the TTS queue, wait
   * for playback to finish, and get back the full accumulated text for history/verification.
   *
   * Centralizing this keeps the flush-boundary tuning (MIN_COMMA_FLUSH_CHARS etc.) and the
   * TTS-unhandled-rejection guard (needed to avoid a Node crash on barge-in) as one source of
   * truth instead of duplicating them per call site.
   */
  private createStreamingTtsSink(
    session: CallSession,
    callSid: string,
  ): {
    onTextDelta: (content: string) => void;
    finish: () => Promise<string>;
    generation: number;
  } {
    let fullResponse = '';
    let sentenceBuffer = '';
    let ttsStarted = false;

    const ttsQueue: string[] = [];
    let ttsQueueClosed = false;
    let notifyTtsQueue: (() => void) | undefined;

    const wakeTtsQueue = () => {
      const notify = notifyTtsQueue;
      notifyTtsQueue = undefined;
      notify?.();
    };

    const pushTtsChunk = (value: string) => {
      const text = value.trim();
      if (!text) return;

      ttsQueue.push(text);
      wakeTtsQueue();

      if (!ttsStarted) {
        ttsStarted = true;
        const base = session.conversationState?.lastUserMessageTime ?? Date.now();
        const latency = Date.now() - base;
        this.logger.log(`🚀 First TTS queued for ${callSid} (${latency}ms after user speech)`);
      }
    };

    const closeTtsQueue = () => {
      ttsQueueClosed = true;
      wakeTtsQueue();
    };

    const ttsTextIterator = (async function* () {
      while (!ttsQueueClosed || ttsQueue.length > 0) {
        const next = ttsQueue.shift();
        if (next) {
          yield next;
          continue;
        }

        await new Promise<void>(resolve => {
          notifyTtsQueue = resolve;
        });
      }
    })();

    session.turnState = 'agent-speaking';
    session.agentSpeakingSince = Date.now();
    session.audioChunksPending = 0;
    session.onTtsStart?.(callSid);
    const myGeneration = this.beginSpeechGeneration(session);

    const ttsPromise = session.ttsClient.streamTTS(
      session.voiceConfig,
      ttsTextIterator,
      async ttsChunk => {
        if (session.turnState !== 'agent-speaking' || session.audioGeneration !== myGeneration) {
          return;
        }

        if (ttsChunk.audio?.length > 0) {
          this.sendAudioToTwilio(session, ttsChunk.audio);
        }
      },
      error => {
        this.logger.error(`❌ TTS stream error for ${callSid}:`, error);
      },
    );
    // finish() awaits ttsPromise via .catch() below, but the sink can sit suspended awaiting the
    // next text delta in between; if ttsPromise rejects during that window (e.g. abort() closes
    // the socket on a barge-in) before finish() ever runs, it's an unhandled rejection — which
    // crashes the whole process on this Node version. Attach a handler immediately; the real
    // error is still observed via the awaited `ttsPromise` in finish().
    ttsPromise.catch(() => {
      /* handled in finish() via `await ttsPromise.catch(...)` */
    });

    // Sentence-end punctuation always flushes immediately (keeps first-audio latency low). A bare
    // comma only flushes once the clause has enough words — flushing on every comma sends 1-2
    // word fragments to TTS in isolation, which loses sentence-level prosody and comes out
    // sounding choppy/slurred.
    const MIN_COMMA_FLUSH_CHARS = 20;
    const boundaryRegex = /[.!?](?:\s|$)|,(?:\s|$)|\n/g;

    const onTextDelta = (content: string) => {
      if (!content) return;
      fullResponse += content;
      sentenceBuffer += content;

      let match: RegExpExecArray | null;
      while ((match = boundaryRegex.exec(sentenceBuffer)) !== null) {
        const end = match.index + match[0].length;
        const isCommaBoundary = match[0].trimEnd().endsWith(',');
        if (isCommaBoundary && end < MIN_COMMA_FLUSH_CHARS) {
          continue;
        }

        const toSpeak = sentenceBuffer.slice(0, end).trim();
        sentenceBuffer = sentenceBuffer.slice(end);
        pushTtsChunk(toSpeak);
        boundaryRegex.lastIndex = 0;
      }
    };

    const finish = async (): Promise<string> => {
      if (
        sentenceBuffer.trim() &&
        session.turnState === 'agent-speaking' &&
        session.audioGeneration === myGeneration
      ) {
        pushTtsChunk(sentenceBuffer.trim());
      }
      closeTtsQueue();
      await ttsPromise.catch((err: unknown) => {
        this.logger.error(`❌ TTS stream failed for ${callSid}:`, err);
      });
      this.flushTwilioPendingAudio(session);
      await this.waitForQueuedAudioToDrain(session);
      return fullResponse.trim();
    };

    return { onTextDelta, finish, generation: myGeneration };
  }

  /**
   * Fire-and-forget quality check for a response that's already being/been spoken. Streaming
   * means audio may already be playing by the time this resolves, so it can only observe, never
   * block or alter what was said — logs a warning when the verifier flags an issue, giving
   * visibility into how often responses need work without paying verification's latency on every
   * turn. Only the semantic check (`verify`) runs; `verifyAndCorrect`'s second, corrective LLM
   * call is skipped entirely since there's nothing left to correct once audio may already be
   * playing.
   */
  private runAsyncResponseVerification(
    callSid: string,
    input: AgentResponseVerificationInput,
  ): void {
    if (!this.verificationService) return;
    this.verificationService
      .verify(input)
      .then(result => {
        if (!result.valid) {
          this.logger.warn(
            `⚠️ Response verification flagged issues for ${callSid} (post-hoc, response already spoken): ${result.issues.join(', ')}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.logger.debug(`Response verification failed for ${callSid}:`, err);
      });
  }

  /**
   * Waits for audio already queued for the telephony provider to actually finish being sent at
   * its real-time pace (Telnyx L16: `ensureTelnyxL16MediaDrain`, one 640-byte/20ms frame at a
   * time; Twilio: `scheduleTwilioMediaDrain`, one 160-byte/20ms frame at a time) — NOT just for
   * the TTS client to finish receiving/transferring the bytes, which for a long response can
   * complete well before the real-time drain has caught up.
   *
   * Without this, `turnState` flips to `'waiting-for-user'` (and `onTtsEnd` fires) while the agent
   * is still audibly speaking: barge-in eligibility and the gateway's echo-suppression are both
   * keyed off `turnState`/`aiSpeaking`, so real user speech during that gap gets processed as an
   * ordinary new turn instead of an interruption — and the response generated for it starts
   * queuing audio on top of the still-draining previous turn, producing audibly
   * overlapping/garbled speech instead of a clean stop-and-listen.
   */
  private async waitForQueuedAudioToDrain(session: CallSession): Promise<void> {
    const POLL_MS = 20;
    const isTelnyx = session.callSid.startsWith('TLX_');
    while (this.sessions.has(session.callSid)) {
      const stillDraining = isTelnyx
        ? (session.telnyxPcm16Pending?.length ?? 0) > 0 || !!session.telnyxL16DrainIntervalId
        : (session.twilioMulawPending?.length ?? 0) > 0 || !!session.twilioDrainActive;
      if (!stillDraining) return;
      await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
    }
  }

  /**
   * CRITICAL: Handle interruption with conversation history truncation
   */
  /** How long (ms) after an interruption we still treat the next user message as "post-interruption" for human-like acknowledgment */
  // private readonly INTERRUPTION_GRACE_MS = 12_000;
  /**
   * CRITICAL: Handle interruption — clear everything within 50ms
   *
   * Timeline:
   * T+0ms:  VAD detects speech onset
   * T+5ms:  TTS abort sent
   * T+10ms: Twilio clear event sent (flushes playback buffer)
   * T+15ms: LLM cancel sent
   * T+20ms: Audio queues cleared
   * T+25ms: Ready for new user input
   */
  /**
   * Handle interruption — stop agent speech immediately.
   *
   * CRITICAL FIXES:
   * 1. Send 'clear' event to flush Twilio's audio buffer
   * 2. Track marks so we know what was actually played vs cleared
   * 3. Cancel in-flight LLM
   * 4. Reset state immediately
   */
  handleInterruption(callSid: string, utteranceUntilInterrupt?: string): void {
    const session = this.sessions.get(callSid);
    if (!session) return;

    this.logger.log(`🛑 Interruption for ${callSid}`);

    // 0. INVALIDATE THIS SPEECH GENERATION — belt-and-suspenders alongside the abort() below.
    // ElevenLabs' WebSocket can keep emitting already-in-flight audio chunk events for up to a
    // couple seconds AFTER abort()/close() is called (frames already sent by the server before the
    // close reaches it). If a NEW speech attempt starts speaking before those stale chunks stop
    // arriving, turnState alone reads 'agent-speaking' for BOTH the old and new attempt — bumping
    // the generation here means every gated check (`session.audioGeneration === myGeneration`)
    // rejects the stale chunks even if the new attempt's own `beginSpeechGeneration()` call hasn't
    // run yet. This is the fix for stale/aborted-turn audio bleeding into (and corrupting) the next
    // turn's playback.
    session.audioGeneration = (session.audioGeneration ?? 0) + 1;

    // 1. ABORT TTS — stops generating new audio
    try {
      session.ttsClient.abort();
    } catch {
      /* ignore */
    }

    // 2. CLEAR ALL PENDING AUDIO
    session.twilioMulawPending = Buffer.alloc(0);
    session.telnyxPcm16Pending = Buffer.alloc(0);
    this.stopTelnyxL16MediaDrain(session);
    session.twilioDrainActive = false;

    // 3. SEND TWILIO 'CLEAR' EVENT — flushes playback buffer
    if (!session.terminalTextOnly && session.twilioWs.readyState === WebSocket.OPEN) {
      try {
        session.twilioWs.send(
          JSON.stringify({
            event: 'clear',
            streamSid: session.streamSid,
          }),
        );
      } catch (e) {
        this.logger.error(`❌ Twilio clear failed for ${callSid}:`, e);
      }
    }

    // 4. CANCEL IN-FLIGHT LLM
    if (session.llmAbortController) {
      session.llmAbortController.abort();
      session.llmAbortController = undefined;
    }

    // 5. RESET STATE
    session.isProcessing = false;
    session.turnState = 'waiting-for-user';
    if (session.conversationState) {
      session.conversationState.isInCoolDown = false;
      session.conversationState.expectedResponseTime = Date.now();
    }

    session.onInterruption?.(callSid);
    session.audioChunksPending = 0;
    session.interruptionAt = Date.now();
    session.interruptionUtterance = (utteranceUntilInterrupt || '').trim() || undefined;

    // 6. CLEAR AUDIO BUFFER
    session.audioBuffer = [];
    if (session.transcriptionTimeoutId) {
      clearTimeout(session.transcriptionTimeoutId);
      session.transcriptionTimeoutId = undefined;
    }

    // 7. TRUNCATE HISTORY to what was actually played
    if (session.isFlowCall && session.flowState?.history?.length > 0) {
      const history = session.flowState.history as { role: string; text?: string }[];
      const lastAgentIndex = history.findLastIndex(h => h.role === 'agent');

      if (lastAgentIndex !== -1) {
        const interruptedMsg = history[lastAgentIndex];
        if (utteranceUntilInterrupt && interruptedMsg.text) {
          const pos = interruptedMsg.text.indexOf(utteranceUntilInterrupt);
          if (pos !== -1) {
            interruptedMsg.text = interruptedMsg.text.substring(
              0,
              pos + utteranceUntilInterrupt.length,
            );
          }
        }
        // else if (interruptedMsg.text) {
        //   interruptedMsg.text = `[Interrupted] ${interruptedMsg.text.substring(0, 30)}...`;
        // }
        history.splice(lastAgentIndex + 1);
      }
    }

    // 8. RELEASE LOCK
    this.releaseTurnLock(session);

    // 9. CLEAR DELAYS
    if (session.conversationState) {
      session.conversationState.isInCoolDown = false;
      session.conversationState.expectedResponseTime = 0;
      session.conversationState.consecutiveReprompts = 0;
    }
    this.clearPendingReprompt(session);
    this.clearPendingIncompleteUtteranceHold(session);

    // 10. NOTIFY GATEWAY
    session.onTtsEnd?.(callSid);
    session.onInterruption?.(callSid);
  }
  /**
   * Get human-readable description of slot name
   */
  private getSlotDescription(slotName: string): string {
    let description = slotName.replace(/_/g, ' ');
    if (description.includes(' name') && !description.includes("'s name")) {
      description = description.replace(/\b(\w+)\s+name\b/gi, "$1's name");
    }
    return description;
  }

  /** Valid short responses we should never treat as noise */
  private static readonly VALID_SHORT_RESPONSES = new Set([
    'yes',
    'no',
    'ok',
    'okay',
    'nope',
    'sure',
    'yeah',
    'yep',
    'nah',
    'hi',
    'hello',
    'thanks',
    'thank you',
    'bye',
    'goodbye',
    'please',
    'alright',
    'right',
    'correct',
    'none',
    'atomic',
    'greek',
    'garlic',
    'cheese',
    'pickles',
    'chipotle',
    'mushroom',
    'wehshi',
    'fillet',
    'delivery',
    'pickup',
  ]);

  /** Skip transcripts that are likely background noise, filler, or STT turning noise into random words */
  private isLikelyNoiseOrFiller(transcript: string, session?: CallSession): boolean {
    const t = transcript.trim();
    if (t.length <= 1) return true;
    if (isKnownMenuShortResponse(t)) return false;
    if (session?.currentFlow && transcriptMatchesAnyFlowSlotAlias(session.currentFlow, t)) {
      return false;
    }
    const lower = t.toLowerCase();
    const words = t.split(/\s+/).filter(Boolean);

    const fillerWords = [
      'um',
      'uh',
      'uhm',
      'eh',
      'ah',
      'hmm',
      'mm',
      'mhm',
      'er',
      'hm',
      'oh',
      'ooh',
      'ahh',
      'like',
      'well',
      'so',
      'anyway',
      'basically',
    ];
    if (fillerWords.includes(lower)) return true;
    if (/^[^\w]*[uhm]+[^\w]*$/i.test(t)) return true;
    if (/^(the|a|an|it|that|this|so|and|or|but)\s*$/i.test(lower)) return true;
    if (/^[\.\,\?\!\-–—\s]+$/i.test(t)) return true;

    if (words.length <= 2) {
      if (ElevenLabsVoiceBridgeService.VALID_SHORT_RESPONSES.has(lower)) return false;
      if (words.length === 1 && words[0].length <= 3 && /^[a-z]+$/i.test(words[0])) return true;
    }

    if (this.isLikelyBackgroundAsWords(t, words)) return true;
    return false;
  }

  /**
   * True only for a bare, reflexive "answering the phone" greeting — "Hello?", "Hi", "Hey",
   * "Hallo" — and nothing else. Deliberately narrow: does NOT match "yes"/"yeah" (those can be a
   * real answer to a yes/no question the greeting just asked) and does NOT match if the transcript
   * has any content beyond the greeting word itself ("Hello, I have a question" must fall through
   * to normal processing). Only meaningful on the caller's very first turn — see call site.
   */
  private isGenericPhoneGreetingOnly(transcript: string): boolean {
    const t = transcript
      .trim()
      .toLowerCase()
      .replace(/[?!.,]+$/g, '')
      .trim();
    if (!t) return true;
    return /^(hello+|hi+|hey+|hiya|yo|hallo|hoi|bonjour|hola|guten\s*tag|good\s*(morning|afternoon|evening))$/i.test(
      t,
    );
  }

  /**
   * Detect when STT has turned background noise or off-topic speech into words we should ignore.
   * Avoids treating TV, other people, or noise as user input.
   */
  private isLikelyBackgroundAsWords(transcript: string, words: string[]): boolean {
    const lower = transcript.toLowerCase();

    if (words.length >= 2 && words.length <= 5) {
      const joined = lower.replace(/\s+/g, ' ');
      if (/thank you for (watching|listening|subscribing)/i.test(joined)) return true;
      if (/please (like|subscribe|comment|share)/i.test(joined)) return true;
      if (/^(what|why|how)\s+(is|are|do|does)\s+/i.test(joined) && words.length <= 4) return false;
    }

    if (words.length === 1) {
      const w = words[0];
      if (
        w.length >= 2 &&
        w.length <= 6 &&
        !ElevenLabsVoiceBridgeService.VALID_SHORT_RESPONSES.has(lower)
      ) {
        if (
          /^[a-z]+$/i.test(w) &&
          !/^(yes|no|ok|pet|max|rex|dr|doctor|bilal|robeel|taha)$/i.test(w)
        ) {
          if (/^(the|and|for|but|not|are|was|has|had|can|all|any|say|see|get|one|two)$/i.test(w))
            return true;
        }
      }
    }

    if (/^[^\p{L}\p{N}]+$/u.test(transcript.replace(/\s/g, ''))) return true;
    if (/(.)\1{3,}/.test(lower)) return true;
    return false;
  }

  /** During reprompt cooldown, only ignore input that looks like noise/short — allow real responses */
  private isShortOrNoiseDuringRepromptCooldown(transcript: string, session?: CallSession): boolean {
    const t = transcript.trim();
    if (isKnownMenuShortResponse(t)) return false;
    if (session?.currentFlow && transcriptMatchesAnyFlowSlotAlias(session.currentFlow, t)) {
      return false;
    }
    if (t.length < 4) return true;
    const wordCount = t.split(/\s+/).filter(Boolean).length;
    if (
      wordCount <= 2 &&
      !['yes', 'no', 'ok', 'okay', 'sure', 'nope', 'yeah', 'yep'].includes(t.toLowerCase()) &&
      !isKnownMenuShortResponse(t)
    ) {
      return true;
    }
    return this.isLikelyNoiseOrFiller(transcript, session);
  }

  /**
   * Process flow-based turn (CORRECTED VERSION)
   */
  private async processFlowTurn(
    session: CallSession,
    callSid: string,
    userTranscript: string,
    isInterruption = false,
    isPartial = false,
    interruptionUtterance?: string,
  ): Promise<void> {
    if (!session.currentFlow || !session.flowState || !this.flowRuntime) {
      this.logger.error(`❌ Missing flow state for ${callSid}`);
      return;
    }

    if (session.flowState.conversationLanguage) {
      session.language = metadataToCanonicalIso6391(session.flowState.conversationLanguage);
      session.conversationLanguage = session.language;
    }

    this.logger.log(
      `🔄 Flow turn for ${callSid}: "${userTranscript.substring(0, 80)}" isInterruption=${isInterruption} isPartial=${isPartial}`,
    );

    // Initialize turn context if not exists
    if (!session.turnContext) {
      session.turnContext = {
        isWaitingForUser: false,
        lastUserActivity: Date.now(),
        partialTranscript: '',
        isProcessingPartial: false,
      };
    }

    // Update activity timestamp
    session.turnContext.lastUserActivity = Date.now();

    // If this is a partial transcript, accumulate and wait
    if (isPartial) {
      session.turnContext.partialTranscript = userTranscript;
      session.turnContext.isProcessingPartial = true;

      // Clear any existing silence timeout
      if (session.turnContext.silenceTimeoutId) {
        clearTimeout(session.turnContext.silenceTimeoutId);
      }

      // Set new silence timeout - if no more transcripts come in, process this as final
      session.turnContext.silenceTimeoutId = setTimeout(() => {
        if (session.turnContext?.partialTranscript) {
          this.logger.log(`🔇 Silence detected, processing accumulated transcript for ${callSid}`);
          // Process the accumulated transcript as final (no interruption context)
          this.processFlowTurn(
            session,
            callSid,
            session.turnContext.partialTranscript,
            false,
            false,
            undefined,
          );
        }
      }, 900); // silence window before treating accumulated partial as final (align ~ STT end-of-utterance)

      return; // Don't process yet, wait for more input or silence
    }

    // If we were accumulating partials and now have final, clear the timeout
    if (session.turnContext.silenceTimeoutId) {
      clearTimeout(session.turnContext.silenceTimeoutId);
      session.turnContext.silenceTimeoutId = undefined;
    }
    session.turnContext.isProcessingPartial = false;
    session.turnContext.partialTranscript = '';

    // CRITICAL FIX: Handle interruption with proper wait time
    if (isInterruption) {
      // User interrupted — they already spoke, don't ask them to repeat
      session.isProcessing = false;

      // Add user transcript to history immediately
      session.flowState.history.push({
        role: 'user',
        text: userTranscript,
        at: new Date().toISOString(),
      });

      const currentNodeId = session.currentNodeId!;
      const currentNode = getNode(session.currentFlow, currentNodeId);
      const listen = getListen(currentNode);

      if (listen?.capture_slot) {
        const slotName = listen.capture_slot;
        const nodeContext = getSayText(currentNode);

        // Try to extract slot from interruption utterance
        const extractedValue = await this.flowRuntime.extractSlotValue(
          slotName,
          userTranscript,
          nodeContext,
          currentNode,
          session.currentFlow,
          { conversationFlowMode: session.conversationFlowMode },
        );

        if (extractedValue) {
          // User gave us what we needed! Continue flow normally
          session.flowState.slots[slotName] = extractedValue;
          this.logger.log(`✅ Slot "${slotName}" from interruption: "${extractedValue}"`);

          const result = await this.flowRuntime.next({
            flow: session.currentFlow,
            state: session.flowState,
            userTranscript,
            isInterruption: false,
            agentConversationContext: session.agentGlobalPreamble,
            conversationFlowMode: session.conversationFlowMode,
            toolExecutionContext: {
              callSid,
              flowId: session.flowState?.flowId,
              language: this.getActiveConversationLanguage(session),
            },
          });
          await this.handleFlowResult(session, callSid, result);
          return;
        }

        // Didn't get slot — brief re-ask ONCE, no delay
        const slotDesc = this.getSlotDescription(slotName);
        const acknowledgment = `Sorry, I need ${slotDesc}.`;
        const toSpeak = await this.speakFlowResponse(session, acknowledgment);
        this.appendFlowAgentHistory(session, toSpeak);

        session.turnContext.isWaitingForUser = true;
        session.onTtsEnd?.(callSid);
        return;
      }

      // Not capturing slot — brief acknowledgment, continue
      const acknowledgment = 'Sorry, go ahead.';
      await this.speakText(session, acknowledgment);
      this.appendFlowAgentHistory(session, acknowledgment);
      return;
    }

    // Normal flow processing
    const utteranceCtx = session.lastUtteranceInterpretation;
    const conversationLang = this.getActiveConversationLanguage(session);
    const result = await this.flowRuntime.next({
      flow: session.currentFlow,
      state: session.flowState,
      userTranscript,
      isInterruption,
      agentConversationContext: session.agentGlobalPreamble,
      conversationFlowMode: session.conversationFlowMode,
      userUtteranceContext: utteranceCtx
        ? {
            originalText: utteranceCtx.originalText,
            detectedLanguage: utteranceCtx.detectedLanguageIso6391,
            replyLanguage: utteranceCtx.replyLanguageIso6391,
          }
        : undefined,
      toolExecutionContext: {
        callSid,
        flowId: session.flowState?.flowId,
        language: conversationLang,
      },
    });

    await this.handleFlowResult(session, callSid, result);
  }

  // Extract flow result handling to separate method
  private async handleFlowResult(
    session: CallSession,
    callSid: string,
    result: any,
  ): Promise<void> {
    if (result.shouldWaitForMoreInput) {
      // Don't speak, just wait for user to finish
      this.logger.log(`⏳ Waiting for user to complete input for ${callSid}`);
      session.turnContext.isWaitingForUser = true;
      return;
    }

    if (result.endCall) {
      const endLang = this.getActiveConversationLanguage(session);
      session.flowState = {
        flowId: session.flowState.flowId,
        currentNode: result.newState.currentNode,
        slots: result.newState.slots,
        history: result.newState.history,
        conversationLanguage: endLang,
      };
      session.conversationLanguage = endLang;
      session.currentNodeId = result.newState.currentNode;

      // Resolve goodbye from result or from flow's end node (handles new structure: id "end-node", name "end_node")
      let goodbyeText =
        (result.responseText ?? result.responsePrompt ?? '').trim() || 'Thank you. Goodbye.';
      let endNodePrompt: string | null = result.responsePrompt?.trim() || null;
      if (session.currentFlow) {
        const endNode =
          getNode(session.currentFlow, result.newState.currentNode) ||
          getNode(session.currentFlow, 'end_node') ||
          getNode(session.currentFlow, 'end-node');
        if (endNode && isEndNode(endNode)) {
          const sayPrompt = getSayPrompt(endNode);
          const sayText = getSayText(endNode);
          if (sayPrompt || sayText) {
            endNodePrompt = sayPrompt ?? sayText ?? null;
            if (!goodbyeText || goodbyeText === 'Thank you. Goodbye.') {
              goodbyeText = endNodePrompt
                ? this.renderTemplate(endNodePrompt, result.newState.slots)
                : 'Thank you. Goodbye.';
            }
          }
        }
      }
      if (!goodbyeText) goodbyeText = 'Thank you. Goodbye.';

      this.logger.log(`👋 End node: saying goodbye then ending call for ${callSid}`);
      // Use literal goodbye when the flow's end instruction is short and closing (avoid AI expanding it)
      const isShortLiteralGoodbye =
        goodbyeText.length <= 120 &&
        !/\b(ask|tell|confirm|provide|give|what|which|do you)\b/i.test(goodbyeText);
      if (endNodePrompt && !isShortLiteralGoodbye) {
        await this.handleFlowPromptNode(session, endNodePrompt, result.newState.slots);
      } else {
        const goodbyeSpoken = await this.speakFlowResponse(session, goodbyeText);
        this.appendFlowAgentHistory(session, goodbyeSpoken);
        this.patchLastAgentHistoryText(session, goodbyeSpoken);
      }
      this.handleAgentEndCallSignal(callSid, 'flow_completed', this.getGoodbyeDelayMs(goodbyeText));
      return;
    }

    // Update state
    // this.clearNoResponseRephraseTimer(session);
    const conversationLang = this.getActiveConversationLanguage(session);
    session.flowState = {
      flowId: session.flowState.flowId,
      currentNode: result.newState.currentNode,
      slots: result.newState.slots,
      history: result.newState.history,
      conversationLanguage: conversationLang,
    };
    session.conversationLanguage = conversationLang;
    session.currentNodeId = result.newState.currentNode;
    session.turnContext = {
      ...session.turnContext,
      isWaitingForUser: result.newState.turnContext?.expectingInput || false,
    };

    const isReprompting = result.handledAs === 'reprompt';

    if (isReprompting && result.responseText) {
      this.clearPendingReprompt(session);
      const count = session.conversationState?.consecutiveReprompts ?? 0;
      if (count >= this.MAX_REPROMPTS) {
        const fallbackEn =
          "I'm having trouble catching that. Let me connect you to someone who can help.";
        this.logger.log(
          `🔄 Reprompt cap (${count}/${this.MAX_REPROMPTS}) — speaking fallback for ${callSid}`,
        );
        session.lastRepromptAt = Date.now();
        const xfer = this.resolveSupportTransferE164(session);
        if (xfer) {
          session.pendingPostSpeechAction = { kind: 'pstn_transfer', to: xfer };
        }
        // speakFlowResponse already speaks (localizes + calls speakText internally) — do not
        // call speakText again here, or the fallback line plays twice and races the async
        // support-transfer hold message that its completion just triggered via pendingPostSpeechAction.
        const fallback = await this.speakFlowResponse(session, fallbackEn, false);
        this.appendFlowAgentHistory(session, fallback);
        this.patchLastAgentHistoryText(session, fallback);
        return;
      }
      const nodeId = result.newState.currentNode;
      this.logger.log(
        `🔄 Deferring reprompt (will speak in ${this.REPROMPT_PAUSE_BEFORE_SAY_MS}ms if you don't respond): "${result.responseText.substring(0, 60)}..."`,
      );
      const timeoutId = setTimeout(() => {
        this.fireDeferredReprompt(session, callSid, nodeId, result.responseText);
      }, this.REPROMPT_PAUSE_BEFORE_SAY_MS);
      session.pendingReprompt = { nodeId, responseText: result.responseText, timeoutId };
      return;
    }
    session.lastRepromptAt = undefined;

    const preface =
      typeof result.prefaceResponseText === 'string' ? result.prefaceResponseText.trim() : '';
    if (preface) {
      if (preface.length <= this.PREFACE_VOICE_MAX_CHARS) {
        const prefaceSpoken = await this.speakFlowResponse(session, preface);
        this.appendFlowAgentHistory(session, prefaceSpoken);
      } else {
        this.logger.log(
          `⏭️ Skipping long preface TTS (${preface.length} chars) — speaking destination turn only`,
        );
      }
    }

    // We moved to a new node - use the next node's configuration (works for both new array format and legacy Record format)
    const nextNode = getNode(session.currentFlow, result.newState.currentNode);
    if (!nextNode) {
      throw new Error(`Node ${result.newState.currentNode} not found`);
    }

    this.logger.log(`➡️ Transitioned to "${result.newState.currentNode}"`);

    const template = getSayTemplate(nextNode);
    const prompt = getSayPrompt(nextNode);
    const flowXferRaw = getTransferDialTo(nextNode);
    const flowXferNorm = flowXferRaw ? normalizePhoneNumber(flowXferRaw) : '';
    const transferFlowId = getTransferFlowId(nextNode);
    const transferAgentId = getTransferAgentId(nextNode);
    if (isPlausibleE164Number(flowXferNorm)) {
      session.pendingPostSpeechAction = { kind: 'pstn_transfer', to: flowXferNorm };
    } else if (transferAgentId) {
      session.pendingPostSpeechAction = { kind: 'agent_transfer', agentId: transferAgentId };
    } else if (transferFlowId) {
      session.pendingPostSpeechAction = { kind: 'flow_transfer', flowId: transferFlowId };
    }
    // const expectUserInput =
    //   !isEndNode(nextNode) && (!!getListen(nextNode) || ((getTransitions(nextNode)?.length ?? 0) > 0));
    if (template) {
      const text = this.renderTemplate(template, result.newState.slots);
      const toSpeak = await this.speakFlowResponse(session, text);
      this.patchLastAgentHistoryText(session, toSpeak);
      if (isEndNode(nextNode)) {
        this.handleAgentEndCallSignal(callSid, 'flow_end', this.getGoodbyeDelayMs(toSpeak));
      }
    } else if (prompt) {
      // await this.handleFlowPromptNode(session, prompt, result.newState.slots, expectUserInput);
      await this.handleFlowPromptNode(session, prompt, result.newState.slots);
      if (isEndNode(nextNode)) {
        this.handleAgentEndCallSignal(callSid, 'flow_end', this.getGoodbyeDelayMs(prompt));
      }
    } else if (isEndNode(nextNode)) {
      this.handleAgentEndCallSignal(callSid, 'flow_end', this.END_CALL_AFTER_GOODBYE_BUFFER_MS);
    } else if (isPlausibleE164Number(flowXferNorm)) {
      // transfer_call node with no instruction text to speak first — nothing will call
      // completeSpeakTextAfterAudio to flush `pendingPostSpeechAction`, so fire the transfer now.
      // Goes through the sequence (not the raw transfer) so the caller still hears a hold message
      // instead of going silent — a flow author leaving instruction text blank shouldn't mean the
      // caller gets no warning before the line changes hands.
      session.pendingPostSpeechAction = undefined;
      void this.runSupportTransferSequence(callSid, flowXferNorm, '').catch((err: unknown) => {
        this.logger.error(`Flow transfer_call node transfer failed for ${callSid}:`, err);
      });
    } else if (transferAgentId) {
      // Same reasoning: no instruction text on the transfer_call node to speak first, so nothing
      // will call completeSpeakTextAfterAudio to flush pendingPostSpeechAction — fire it now.
      session.pendingPostSpeechAction = undefined;
      void this.runAgentTransferSequence(callSid, transferAgentId, '').catch((err: unknown) => {
        this.logger.error(`Agent transfer_call node transfer failed for ${callSid}:`, err);
      });
    } else if (transferFlowId) {
      session.pendingPostSpeechAction = undefined;
      void this.runFlowTransferSequence(callSid, transferFlowId, '').catch((err: unknown) => {
        this.logger.error(`Flow-to-flow transfer_call node transfer failed for ${callSid}:`, err);
      });
    }
  }

  /**
   * Schedule a rephrase for when the user doesn't respond after we asked (long silence).
   * Fires after NO_RESPONSE_REPHRASE_MS. Respects MAX_REPROMPTS so we don't rephrase forever.
   */
  // private scheduleNoResponseRephrase(session: CallSession, callSid: string): void {
  //   if (session.noResponseTimeoutId) {
  //     clearTimeout(session.noResponseTimeoutId);
  //     session.noResponseTimeoutId = undefined;
  //   }
  //   if (!session.isFlowCall || !session.currentFlow || !session.currentNodeId || !this.flowRuntime) {
  //     return;
  //   }
  //   const count = session.conversationState?.consecutiveReprompts ?? 0;
  //   if (count >= this.MAX_REPROMPTS) {
  //     return;
  //   }
  //   const node = getNode(session.currentFlow, session.currentNodeId);
  //   const listen = getListen(node);
  //   const hasEdges = (getTransitions(node)?.length ?? 0) > 0;
  //   if (!listen && !hasEdges) return;
  //
  //   const nodeIdWhenScheduled = session.currentNodeId;
  //   session.noResponseTimeoutId = setTimeout(async () => {
  //     session.noResponseTimeoutId = undefined;
  //     const s = this.sessions.get(callSid);
  //     if (!s || !s.isFlowCall || s.currentNodeId !== nodeIdWhenScheduled) return;
  //     if (s.isProcessing) return;
  //     const lastUser = s.conversationState?.lastUserMessageTime ?? 0;
  //     if (lastUser && Date.now() - lastUser < 3000) return;
  //     const currentCount = s.conversationState?.consecutiveReprompts ?? 0;
  //     if (currentCount >= this.MAX_REPROMPTS) return;
  //     const currentNode = getNode(s.currentFlow!, s.currentNodeId!);
  //     if (!currentNode) return;
  //     try {
  //       const rephrase = await this.flowRuntime.getNoResponseRephrase(currentNode, s.flowState.slots, {
  //         language: s.language,
  //       });
  //       this.logger.log(`⏱️ Long silence — rephrasing for ${callSid}: "${rephrase.substring(0, 60)}..."`);
  //       await this.speakText(s, rephrase, true);
  //       this.scheduleNoResponseRephrase(s, callSid);
  //     } catch (err) {
  //       this.logger.error(`No-response rephrase failed for ${callSid}:`, err);
  //     }
  //   }, this.NO_RESPONSE_REPHRASE_MS);
  // }

  // private clearNoResponseRephraseTimer(session: CallSession): void {
  //   if (session.noResponseTimeoutId) {
  //     clearTimeout(session.noResponseTimeoutId);
  //     session.noResponseTimeoutId = undefined;
  //   }
  // }

  /**
   * Handle flow prompt node with OpenAI.
   * When session.language is set, instructs the model to respond in that language.
   */
  private async handleFlowPromptNode(
    session: CallSession,
    promptTemplate: string,
    slots: Record<string, any>,
    options?: { addCallStartIntroduction?: boolean },
    // scheduleNoResponseAfterEnd = false,
  ): Promise<void> {
    const prompt = this.renderTemplate(promptTemplate, slots);
    const languageInstruction = languageInstructionForLlmPrompt(
      this.getActiveConversationLanguage(session),
    );
    const agentBlock = session.agentGlobalPreamble?.trim();
    const personaPrefix = agentBlock ? `${agentBlock}\n\n` : '';

    const rigidRules =
      'AGENTIC RULES: Lead the conversation one step at a time. If the user goes off-topic, acknowledge briefly then redirect: "I\'d be happy to help with that later. Right now I need [what this step asks]." If you didn\'t hear clearly, ask once for the needed information. Keep responses to 1-2 short sentences. Be warm but firm; keep the user moving toward the call goal.';
    const flexRules =
      'FLEX MODE: Use the full conversation history; speak naturally while fulfilling this step. If the user goes off-topic, acknowledge briefly and steer back toward the flow goal. Keep responses to 1-2 short sentences.';
    const agenticRules = session.conversationFlowMode === 'flex' ? flexRules : rigidRules;

    const flowTools = session.currentFlow ? getFlowToolDefinitions(session.currentFlow) : [];
    const useToolLoop = flowTools.length > 0;
    const toolsHint = useToolLoop
      ? '\n\nWhen helpful, use the provided functions to fetch data before answering. Never read raw JSON or field names aloud—summarize for the caller in natural speech.'
      : '';
    const ackInstruction = this.consumePendingLanguageAckInstruction(session);
    const ackBlock = ackInstruction ? `\n\n${ackInstruction}` : '';

    const messages: ConversationMessage[] = [
      {
        role: 'system',
        content: `${languageInstruction}${personaPrefix}You are a phone agent in control of this call. Stay on script. ${prompt}

${agenticRules}${toolsHint}

${this.AGENT_BEHAVIOR_GUIDELINES}${ackBlock}`,
      },
      ...session.flowState.history.map((h: any) => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.text,
      })),
    ];

    const isCallStartGreeting = options?.addCallStartIntroduction === true;

    // Streaming path: plain in-conversation turns only (no tools, not the call-start greeting —
    // see plan notes: tool calls need the complete function-call JSON before executing, and the
    // greeting's duplicate-intro check needs the complete response text to check against).
    if (!useToolLoop && !isCallStartGreeting) {
      const abortController = new AbortController();
      session.llmAbortController = abortController;
      try {
        const openaiStream = await session.openaiClient.streamConversationChat(
          messages,
          OpenAIModel.GPT_4O_MINI,
          { temperature: 0.7, maxTokens: 120, signal: abortController.signal },
        );

        // Push a placeholder now, before any text exists, so handleInterruption's history
        // truncation (which finds and trims the LAST agent entry) has this turn's own entry to
        // match against if the user barges in mid-stream — pushing only after the full response
        // is known would let a mid-stream interruption corrupt the PREVIOUS turn's entry instead.
        const historyEntry: { role: string; text: string; at: string } = {
          role: 'agent',
          text: '',
          at: new Date().toISOString(),
        };
        session.flowState.history.push(historyEntry);

        const sink = this.createStreamingTtsSink(session, session.callSid);
        let finalResponse: string;
        try {
          for await (const chunk of openaiStream) {
            if (abortController.signal.aborted) {
              this.logger.log(`⏹️ LLM stream aborted for ${session.callSid}`);
              break;
            }
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              sink.onTextDelta(content);
              historyEntry.text += content;
            }
          }
        } finally {
          finalResponse = await sink.finish();
        }
        historyEntry.text = finalResponse;

        if (finalResponse) {
          this.runAsyncResponseVerification(session.callSid, {
            generatedResponse: finalResponse,
            userInput:
              session.flowState.history.filter((h: any) => h.role === 'user').pop()?.text ?? '',
            nodeContext: prompt,
            language: session.language ?? 'en',
            generationType: 'prompt_response',
            recentTurns: session.flowState.history
              .slice(-6)
              .map((h: any) => ({ role: h.role, text: h.text })),
          });
        }

        if (session.turnState === 'agent-speaking' && session.audioGeneration === sink.generation) {
          session.turnState = 'waiting-for-user';
          session.onTtsEnd?.(session.callSid);
          this.completeSpeakTextAfterAudio(session, finalResponse, 0, sink.generation);
        }
      } catch (err) {
        this.logger.error(`❌ Flow streaming turn error for ${session.callSid}:`, err);
        session.turnState = 'waiting-for-user';
        session.onTtsEnd?.(session.callSid);
      } finally {
        session.llmAbortController = undefined;
      }
      return;
    }

    // Blocking path: tool-loop turns (Stage 2 streaming deferred, see plan) and the call-start
    // greeting (intentionally kept non-streaming — see comment above).
    let rawResponse: string;
    if (useToolLoop) {
      const myTurn = session.turnSequence;
      const callState = this.callStateService.findOne(session.callSid);
      const toolContext = {
        slots,
        companyId: callState?.companyId,
        callSid: session.callSid,
        phoneNumberTo: callState?.phoneNumberTo,
        phoneNumberFrom: callState?.phoneNumberFrom,
        flowId: session.flowState?.flowId,
        language: session.language,
        openaiClient: session.openaiClient,
      };
      rawResponse = await this.flowToolExecutor.runToolAugmentedChat(
        session.openaiClient,
        messages as ChatCompletionMessageParam[],
        flowTools,
        toolContext,
        {
          model: OpenAIModel.GPT_4O_MINI,
          temperature: 0.7,
          maxTokens: 120,
          // Speak an immediate filler in parallel with the tool round trip(s) so the caller never
          // sits in silence across a multi-step lookup. Fire-and-forget: this runs concurrently with
          // tool execution, not blocking it.
          onBeforeToolExecution: () => {
            void this.speakToolCallFiller(session);
          },
        },
      );
      // Let any filler audio actually finish draining to the telephony provider before the real
      // answer starts, so the two never overlap.
      await this.waitForQueuedAudioToDrain(session);
      // runToolAugmentedChat has no cancellation — if this turn was superseded (barge-in, or a new
      // user turn) while the tool chain was still running in the background, its answer is stale;
      // speaking it now would talk over or after the turn that already replaced it.
      if (session.turnSequence !== myTurn || !this.sessions.has(session.callSid)) {
        this.logger.debug(
          `⏭️ Tool-loop response for ${session.callSid} superseded by a newer turn — discarding`,
        );
        return;
      }
    } else {
      rawResponse = await session.openaiClient.chatCompletion(messages, OpenAIModel.GPT_4O_MINI, {
        temperature: 0.7,
        maxTokens: 120,
      });
    }
    const response =
      this.verificationService && rawResponse?.trim()
        ? await this.verificationService.verifyAndCorrect({
            generatedResponse: rawResponse.trim(),
            userInput:
              session.flowState.history.filter((h: any) => h.role === 'user').pop()?.text ?? '',
            nodeContext: prompt,
            language: session.language ?? 'en',
            generationType: 'prompt_response',
            recentTurns: session.flowState.history
              .slice(-6)
              .map((h: any) => ({ role: h.role, text: h.text })),
          })
        : (rawResponse?.trim() ?? '');

    const finalResponse = isCallStartGreeting
      ? this.applyAgentIntroductionIfNeeded(response, session)
      : response;

    session.flowState.history.push({
      role: 'agent',
      text: finalResponse,
      at: new Date().toISOString(),
    });

    await this.speakText(session, finalResponse);
  }

  /** Hooks passed to the extracted telephony-audio-sender drain functions. */
  private readonly telephonyDrainHooks: TelephonyDrainHooks = {
    isSessionAlive: (callSid: string) => this.sessions.has(callSid),
    onError: (message: string, err: unknown) => {
      this.logger.error(message, err);
    },
  };

  /**
   * Queue TTS audio for the telephony provider and send at real-time rate (frame pacing lives in
   * `telephony-audio-sender.util.ts` — see that file for why: sending the entire buffer in one
   * `media` event often results in no audible playback).
   */
  private sendAudioToTwilio(session: CallSession, pcm16kBuffer: Buffer) {
    queueAudioForTelephony(session, pcm16kBuffer, this.telephonyDrainHooks);
  }

  private stopTelnyxL16MediaDrain(session: CallSession): void {
    stopTelnyxL16MediaDrain(session);
  }

  /** Pad last partial frame and drain so the tail is played. */
  private flushTwilioPendingAudio(session: CallSession) {
    flushTwilioPendingAudio(session, this.telephonyDrainHooks);
  }

  /** E.164 support line: call metadata `supportTransferPhoneNumber` overrides `SUPPORT_TRANSFER_PHONE_NUMBER`. */
  private resolveSupportTransferE164(session: CallSession): string | null {
    const cs = this.callStateService.findOne(session.callSid);
    const meta = cs?.metadata;
    const fromMetaRaw =
      meta && typeof meta.supportTransferPhoneNumber === 'string'
        ? normalizePhoneNumber(meta.supportTransferPhoneNumber)
        : '';
    if (fromMetaRaw && !isPlausibleE164Number(fromMetaRaw)) {
      this.logger.warn(
        `Ignoring call metadata supportTransferPhoneNumber for ${session.callSid} — "${fromMetaRaw}" is not a valid E.164 number`,
      );
    }
    const fromMeta = isPlausibleE164Number(fromMetaRaw) ? fromMetaRaw : '';

    const fromEnvRaw = normalizePhoneNumber(
      this.configService.get<string>('app.supportTransferPhoneNumber') ?? '',
    );
    if (fromEnvRaw && !isPlausibleE164Number(fromEnvRaw)) {
      this.logger.warn(
        `Ignoring SUPPORT_TRANSFER_PHONE_NUMBER — "${fromEnvRaw}" is not a valid E.164 number`,
      );
    }
    const fromEnv = isPlausibleE164Number(fromEnvRaw) ? fromEnvRaw : '';

    return fromMeta || fromEnv || null;
  }

  /**
   * Non-flow calls (`processAIConversationTurn`) have no flow graph, so there is no
   * slot/intent-extraction failure to mark a turn as a "reprompt" the way the flow engine does.
   * "Stuck" is inferred instead from the agent repeating itself turn-over-turn; "user wants a
   * human" is inferred from handoff phrases in the agent's own reply (same detector the flow path
   * uses on its reprompt fallback text). Only mutates `session.pendingPostSpeechAction` — the
   * transfer (with its own "connecting you to support" hold message) runs after the reply that
   * triggered it finishes playing, via `completeSpeakTextAfterAudio`.
   */
  private detectNonFlowHandoffTrigger(session: CallSession, responseText: string): void {
    session.conversationState ??= {
      lastAgentMessageTime: 0,
      lastUserMessageTime: 0,
      consecutiveReprompts: 0,
      isInCoolDown: false,
      expectedResponseTime: 0,
    };
    const state = session.conversationState;
    const isRepeat = this.isNearDuplicateResponse(responseText, session.lastAgentResponse ?? '');
    state.consecutiveReprompts = isRepeat ? state.consecutiveReprompts + 1 : 0;

    const stuck = state.consecutiveReprompts >= this.MAX_REPROMPTS;
    if (!stuck && !messageImpliesSupportHandoff(responseText)) return;

    const dest = this.resolveSupportTransferE164(session);
    if (!dest) return;

    if (stuck) {
      this.logger.log(
        `🔄 Non-flow stuck-loop cap (${state.consecutiveReprompts}/${this.MAX_REPROMPTS}) — escalating to support for ${session.callSid}`,
      );
      state.consecutiveReprompts = 0;
    }
    session.pendingPostSpeechAction = { kind: 'pstn_transfer', to: dest };
  }

  /** Loose "same thing again" check: exact match after normalizing, or ≥80% shared vocabulary. */
  private isNearDuplicateResponse(a: string, b: string): boolean {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .trim();
    const na = normalize(a);
    const nb = normalize(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const wordsA = new Set(na.split(/\s+/));
    const wordsB = new Set(nb.split(/\s+/));
    const shared = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 && shared / union >= 0.8;
  }

  private finalizeVoiceSessionForHandoff(callSid: string): void {
    const session = this.sessions.get(callSid);
    const callState = this.callStateService.findOne(callSid);
    if (session && callState?.metadata?.callType === 'inbound') {
      void this.inboundInsightService.persistAfterInboundCall(
        callSid,
        this.buildInboundTranscriptForInsight(session),
      );
    }
    if (session?.noResponseTimeoutId) {
      clearTimeout(session.noResponseTimeoutId);
    }
    if (session?.endCallTimeoutId) {
      clearTimeout(session.endCallTimeoutId);
    }
    if (session?.maxCallDurationTimeoutId) {
      clearTimeout(session.maxCallDurationTimeoutId);
    }
    this.cleanupSession(callSid);
  }

  /**
   * Short LLM recap of the conversation so far, generated at handoff time (human transfer or
   * flow-to-flow) so whoever/whatever picks up next has context without the caller repeating
   * themselves. Persisted onto the call record — not spoken (we can't whisper it to a human
   * picking up the PSTN leg in this architecture, and repeating it aloud to the caller would be
   * redundant with what they just said). Best-effort: returns '' on failure or too little to summarize.
   */
  private async generateHandoffSummary(session: CallSession): Promise<string> {
    // Flow calls keep their transcript on flowState.history; non-flow calls (no assigned flow —
    // see processAIConversationTurn) only have the raw LLM message list. Fall back so the
    // non-flow escalation path (detectNonFlowHandoffTrigger) also gets a real summary.
    const history = (session.flowState?.history ?? []) as { role: string; text?: string }[];
    let turnLines = history
      .filter(h => (h.role === 'user' || h.role === 'agent') && (h.text ?? '').trim() !== '')
      .slice(-16)
      .map(h => `${h.role === 'user' ? 'Caller' : 'Agent'}: ${(h.text ?? '').trim()}`);
    if (turnLines.length < 2) {
      turnLines = session.conversationHistory
        .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
        .slice(-16)
        .map(m => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content.trim()}`);
    }
    if (turnLines.length < 2) return '';

    const slots = session.flowState?.slots ?? {};
    const slotLine = Object.entries(slots)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');

    try {
      const raw = await session.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content:
              'Summarize this phone call so far in 1-2 short sentences for whoever is taking over the call next. State what the caller wants and any key details already collected. No greetings, no filler, plain text only.',
          },
          {
            role: 'user',
            content: `Transcript:\n${turnLines.join('\n')}${slotLine ? `\n\nCollected info: ${slotLine}` : ''}`,
          },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.2, maxTokens: 100 },
      );
      return raw.trim().slice(0, 600);
    } catch (e: unknown) {
      this.logger.debug(
        `Handoff summary generation failed (non-fatal) for ${session.callSid}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return '';
    }
  }

  private supportTransferHoldMessage(session: CallSession): string {
    const lang = metadataToCanonicalIso6391(session.language);
    if (lang === 'no') {
      return 'Jeg kobler deg til kundestøtte nå. Vennligst vent et øyeblikk.';
    }
    return "I'm connecting you to our support team now. One moment, please.";
  }

  /**
   * Spoken only when a `transfer_call` (flow destination) node has no instruction text of its own —
   * otherwise the caller would hear silence right before the topic switches. Named after the target
   * flow when available, so it reads as a handoff rather than an unexplained jump.
   */
  private flowTransferTransitionMessage(session: CallSession, targetFlowName?: string): string {
    const lang = metadataToCanonicalIso6391(session.language);
    const name = targetFlowName?.trim();
    if (lang === 'no') {
      return name ? `Ett øyeblikk, jeg kobler deg til ${name}.` : 'Ett øyeblikk, vær så snill.';
    }
    return name ? `One moment, let me connect you with ${name}.` : 'One moment, please.';
  }

  /** Record the last spoken agent line on the transcript if not already the latest turn (flow or script). */
  private ensureAgentLineInTranscript(session: CallSession, spoken: string): void {
    this.appendFlowAgentHistory(session, spoken);
  }

  /**
   * Buffer after the handoff line finishes, speak a short “connecting to support” prompt (with transcript updates), then PSTN transfer.
   */
  private async runSupportTransferSequence(
    callSid: string,
    destE164: string,
    lastAgentText: string,
  ): Promise<void> {
    const isTelnyx = callSid.startsWith('TLX_');
    if (isTelnyx) {
      this.telnyxSupportHandoffHangupSuppressed.add(callSid);
    }
    try {
      const session = this.sessions.get(callSid);
      if (session) {
        // Kick off in parallel with the hold-message delay below so it doesn't add latency to the
        // actual transfer — persisted once ready, whether that lands before or after the transfer.
        const summaryPromise = this.generateHandoffSummary(session);
        this.ensureAgentLineInTranscript(session, lastAgentText);
        await this.delay(this.SUPPORT_TRANSFER_TAIL_BUFFER_MS);
        const holdMsg = this.supportTransferHoldMessage(session);
        this.appendFlowAgentHistory(session, holdMsg);
        if (session.terminalTextOnly) {
          process.stdout.write(`\nAgent: ${holdMsg}\n\n`);
        } else {
          await this.speakText(session, holdMsg, false);
        }
        await this.delay(this.SUPPORT_TRANSFER_AFTER_HOLD_BUFFER_MS);
        void summaryPromise
          .then(summary => {
            if (!summary) return;
            return this.callRecordService.mergeMetadata(callSid, {
              handoff: {
                type: 'human_transfer',
                to: destE164,
                summary,
                at: new Date().toISOString(),
              },
            });
          })
          .catch((e: unknown) => {
            this.logger.debug(
              `Persisting handoff summary failed (non-fatal) for ${callSid}: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
      } else {
        await this.delay(this.SUPPORT_TRANSFER_TAIL_BUFFER_MS);
      }
      await this.executePstnTransfer(callSid, destE164);
    } catch (e: unknown) {
      this.logger.error(`Support transfer sequence failed for ${callSid}:`, e);
    } finally {
      if (isTelnyx) {
        this.telnyxSupportHandoffHangupSuppressed.delete(callSid);
      }
    }
  }

  private async executePstnTransfer(callSid: string, toRaw: string): Promise<void> {
    if (this.supportTransfersStarted.has(callSid)) return;
    const to = normalizePhoneNumber(toRaw);
    if (!isPlausibleE164Number(to)) {
      this.logger.warn(
        `Support transfer skipped — "${to}" is not a valid E.164 destination for ${callSid}`,
      );
      return;
    }
    this.supportTransfersStarted.add(callSid);
    const isTelnyx = callSid.startsWith('TLX_');
    try {
      const callState = this.callStateService.findOne(callSid);

      if (isTelnyx) {
        const controlId =
          typeof callState?.metadata?.telnyxCallControlId === 'string' &&
          callState.metadata.telnyxCallControlId !== ''
            ? callState.metadata.telnyxCallControlId
            : callSid.slice(4);
        const dbXferNumber = callState?.companyId
          ? await this.platformInboundVoice.resolveOutboundNumber(callState.companyId)
          : null;
        const xferFromRaw =
          this.configService.get<string>('app.telnyxTransferFromNumber')?.trim() ||
          dbXferNumber ||
          this.telnyxPhoneNumberService.resolveFromNumber(callState?.companyId) ||
          this.configService.get<string>('app.twilioPhoneNumber')?.trim() ||
          '';
        const fromNorm = xferFromRaw ? normalizePhoneNumber(xferFromRaw) : '';
        const fromForXfer = fromNorm.length > 2 ? fromNorm : undefined;
        this.logger.debug(
          `Initiating Telnyx transfer for ${callSid} → ${to} (from: ${fromForXfer ?? '(omitted — Telnyx default)'})`,
        );
        // Transfer before streaming_stop: `streaming_stop` triggers a media WS `stop` → gateway calls
        // `bridge.stop` → `performEndCall` → `endCall`, which ends the PSTN leg before `transfer` completes.
        await this.telnyxClient.transferCall(controlId, to, fromForXfer);
        this.logger.log(`✅ Telnyx transfer issued for ${callSid} → ${to}`);
        await this.telnyxClient.stopBidirectionalStream(controlId).catch((e: unknown) => {
          this.logger.debug(
            `Telnyx streaming_stop after transfer (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        });
        this.finalizeVoiceSessionForHandoff(callSid);
      } else {
        this.finalizeVoiceSessionForHandoff(callSid);
        const baseRaw = this.configService.get<string>('webhook.baseUrl');
        const base = baseRaw?.trim() ?? '';
        if (!base) {
          this.logger.error('WEBHOOK_BASE_URL missing; cannot redirect Twilio call to support');
          return;
        }
        const withProto =
          base.startsWith('http://') || base.startsWith('https://') ? base : `https://${base}`;
        const origin = withProto.replace(/\/$/, '');
        const url = `${origin}/webhook/twilio/transfer-support`;
        await this.twilioClient.redirectCallToUrl(callSid, url);
        this.logger.log(`✅ Twilio redirect to support dial for ${callSid}`);
      }
    } catch (e: unknown) {
      this.logger.error(`Support transfer failed for ${callSid}:`, e);
      if (isTelnyx) {
        this.finalizeVoiceSessionForHandoff(callSid);
      }
    } finally {
      setTimeout(() => this.supportTransfersStarted.delete(callSid), 120_000);
    }
  }

  /**
   * Internal flow-to-flow handoff: no telephony involved — the same call keeps running, just
   * switches its active conversation flow. Requires the target to be a *published* flow in the
   * *same company* as the current call (enforced here, not just at flow-authoring/validate time,
   * since a flow can be unpublished or deleted after another flow's transfer_call node was wired
   * to it). Slots and history carry over so the caller doesn't have to repeat themselves.
   */
  /**
   * Core of an internal handoff: swaps session.currentFlow/flowState, merges slots/history (real
   * collected data outranks the new flow's regenerated defaults — companyName etc. are the same
   * call/company anyway), updates callState so the rest of the call record reflects the new flow,
   * tracks usage, and speaks the new flow's first message. Shared by runFlowTransferSequence
   * (flow destination) and runAgentTransferSequence (agent destination — same swap underneath,
   * with identity fields — voice/language/persona — applied by the caller beforehand).
   */
  private async switchSessionToFlow(
    session: CallSession,
    callState: ReturnType<CallStateService['findOne']>,
    targetFlow: ConversationFlow,
    companyId: string,
  ): Promise<void> {
    const built = this.buildFlowConfigFromMetadata({
      ...callState,
      metadata: { ...callState?.metadata, flow: targetFlow.flow, flowId: targetFlow.id },
    });

    const oldSlots = session.flowState?.slots ?? {};
    const oldHistory = session.flowState?.history ?? [];
    session.currentFlow = built.flow;
    session.flowState = {
      flowId: targetFlow.id,
      currentNode: built.initialState.currentNode,
      slots: { ...built.initialState.slots, ...oldSlots },
      history: oldHistory,
      conversationLanguage: session.flowState?.conversationLanguage,
    };
    session.currentNodeId = built.initialState.currentNode;
    session.isFlowCall = true;

    if (callState) {
      callState.metadata ??= {};
      callState.metadata.flowId = targetFlow.id;
      callState.metadata.flowCompanyId = companyId;
    }

    if (this.flowsService) {
      void this.flowsService.trackUsage(targetFlow.id, true).catch((e: unknown) => {
        this.logger.debug(
          `trackUsage after transfer failed (non-fatal) for ${targetFlow.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }

    const startNode = getNode(session.currentFlow, built.initialState.currentNode);
    if (built.firstMessage) {
      const toSpeak = await this.speakFlowResponse(session, built.firstMessage);
      this.appendFlowAgentHistory(session, toSpeak);
      this.patchLastAgentHistoryText(session, toSpeak);
    } else if (getSayPrompt(startNode)) {
      await this.handleFlowPromptNode(session, getSayPrompt(startNode)!, session.flowState.slots);
    } else if (this.flowRuntime) {
      const fallbackFirst = this.flowRuntime.buildFirstMessage(
        session.currentFlow,
        session.flowState.slots,
        session.language,
        { treatAsOutbound: session.isOutboundCall === true },
      );
      if (fallbackFirst) {
        const toSpeak = await this.speakFlowResponse(session, fallbackFirst);
        this.appendFlowAgentHistory(session, toSpeak);
        this.patchLastAgentHistoryText(session, toSpeak);
      }
    }
  }

  /**
   * Rule: if a configured agent/flow transfer target is missing, unpublished, or otherwise can't
   * be resolved, fall back to Human Support; if that's not configured either, notify the caller
   * and let the current conversation continue rather than stranding them in silence.
   */
  private async handleTransferUnavailable(
    callSid: string,
    session: CallSession,
    kind: 'flow' | 'agent',
  ): Promise<void> {
    const dest = this.resolveSupportTransferE164(session);
    if (dest) {
      this.logger.log(
        `↩️ Falling back to human support for ${callSid} (${kind} transfer unavailable)`,
      );
      await this.runSupportTransferSequence(callSid, dest, '');
      return;
    }
    this.logger.warn(
      `${kind} transfer unavailable for ${callSid} and no human support configured — notifying caller`,
    );
    const fallback = this.transferUnavailableMessage(session);
    this.appendFlowAgentHistory(session, fallback);
    await this.speakText(session, fallback, false);
  }

  private transferUnavailableMessage(session: CallSession): string {
    const lang = metadataToCanonicalIso6391(session.language);
    if (lang === 'no') {
      return 'Beklager, jeg kan ikke overføre deg akkurat nå. La oss fortsette — hvordan kan jeg hjelpe deg?';
    }
    return "I'm sorry, I'm not able to transfer you right now. Let's continue — how can I help you?";
  }

  private async runFlowTransferSequence(
    callSid: string,
    targetFlowId: string,
    lastAgentText: string,
  ): Promise<void> {
    if (this.flowTransfersInProgress.has(callSid)) return;
    this.flowTransfersInProgress.add(callSid);
    try {
      const session = this.sessions.get(callSid);
      if (!session) return;
      const fromFlowId = session.flowState?.flowId;
      // Capture before flowState is overwritten below — summarizes the OLD flow's conversation.
      const summaryPromise = this.generateHandoffSummary(session);
      if (lastAgentText) {
        this.ensureAgentLineInTranscript(session, lastAgentText);
      }

      if (!this.flowsService) {
        this.logger.error(`Flow transfer skipped for ${callSid}: FlowsService not available`);
        await this.handleTransferUnavailable(callSid, session, 'flow');
        return;
      }
      const callState = this.callStateService.findOne(callSid);
      const companyId =
        (callState?.metadata?.flowCompanyId as string | undefined) || callState?.companyId;
      if (!companyId) {
        this.logger.error(`Flow transfer skipped for ${callSid}: no company context on call`);
        await this.handleTransferUnavailable(callSid, session, 'flow');
        return;
      }

      const publishedFlows = await this.flowsService
        .getPublishedByCompany(companyId, targetFlowId)
        .catch(() => []);
      const targetFlow = publishedFlows[0];
      if (!targetFlow) {
        this.logger.error(
          `Flow transfer failed for ${callSid}: flow ${targetFlowId} not found or not published in company ${companyId}`,
        );
        await this.handleTransferUnavailable(callSid, session, 'flow');
        return;
      }

      // No instruction text was spoken for this node — don't let the topic switch in silence.
      if (!lastAgentText) {
        const transition = this.flowTransferTransitionMessage(session, targetFlow.name);
        const toSpeak = await this.speakFlowResponse(session, transition);
        this.appendFlowAgentHistory(session, toSpeak);
        this.patchLastAgentHistoryText(session, toSpeak);
        await this.delay(this.FLOW_TRANSFER_TRANSITION_PAUSE_MS);
      }

      await this.switchSessionToFlow(session, callState, targetFlow, companyId);
      this.logger.log(`🔀 Flow transfer for ${callSid} -> "${targetFlow.name}" (${targetFlow.id})`);

      // Accumulate rather than overwrite — a call can legitimately transfer flows more than once.
      void summaryPromise
        .then(summary => {
          const entry = {
            from: fromFlowId ?? null,
            to: targetFlow.id,
            toName: targetFlow.name,
            summary: summary || null,
            at: new Date().toISOString(),
          };
          const prior = Array.isArray(callState?.metadata?.flowTransfers)
            ? (callState.metadata.flowTransfers as unknown[])
            : [];
          const flowTransfers = [...prior, entry];
          if (callState) {
            callState.metadata ??= {};
            callState.metadata.flowTransfers = flowTransfers;
          }
          return this.callRecordService.mergeMetadata(callSid, { flowTransfers });
        })
        .catch((e: unknown) => {
          this.logger.debug(
            `Persisting flow-transfer summary failed (non-fatal) for ${callSid}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    } catch (e: unknown) {
      this.logger.error(`Flow transfer sequence failed for ${callSid}:`, e);
    } finally {
      this.flowTransfersInProgress.delete(callSid);
    }
  }

  /**
   * Agent-to-agent handoff: resolves the target Agent's own conversation flow and switches to it
   * (same mechanics as runFlowTransferSequence), and additionally swaps voice, language, persona,
   * and interruption sensitivity to match the new agent — a different agent taking over should
   * sound and behave like a different agent, not just run different flow content under the old one.
   * Only agents whose response engine is `conversation-flow` are supported as transfer targets;
   * anything else (script/LLM engines, missing/unpublished agent) falls back to Human Support.
   */
  private async runAgentTransferSequence(
    callSid: string,
    targetAgentId: string,
    lastAgentText: string,
  ): Promise<void> {
    if (this.flowTransfersInProgress.has(callSid)) return;
    this.flowTransfersInProgress.add(callSid);
    try {
      const session = this.sessions.get(callSid);
      if (!session) return;
      const fromFlowId = session.flowState?.flowId;
      const summaryPromise = this.generateHandoffSummary(session);
      if (lastAgentText) {
        this.ensureAgentLineInTranscript(session, lastAgentText);
      }

      if (!this.agentsService || !this.flowsService) {
        this.logger.error(
          `Agent transfer skipped for ${callSid}: AgentsService/FlowsService not available`,
        );
        await this.handleTransferUnavailable(callSid, session, 'agent');
        return;
      }
      const callState = this.callStateService.findOne(callSid);
      const companyId =
        (callState?.metadata?.flowCompanyId as string | undefined) || callState?.companyId;
      if (!companyId) {
        this.logger.error(`Agent transfer skipped for ${callSid}: no company context on call`);
        await this.handleTransferUnavailable(callSid, session, 'agent');
        return;
      }

      const targetAgent = await this.agentsService
        .findOne(targetAgentId, companyId)
        .catch(() => null);
      if (!targetAgent?.isPublished) {
        this.logger.error(
          `Agent transfer failed for ${callSid}: agent ${targetAgentId} not found or not published in company ${companyId}`,
        );
        await this.handleTransferUnavailable(callSid, session, 'agent');
        return;
      }
      if (
        !isConversationFlowEngine(targetAgent.responseEngine) ||
        !targetAgent.responseEngine.conversation_flow_id
      ) {
        this.logger.error(
          `Agent transfer failed for ${callSid}: agent ${targetAgentId} is not a conversation-flow agent`,
        );
        await this.handleTransferUnavailable(callSid, session, 'agent');
        return;
      }
      const targetFlowId = targetAgent.responseEngine.conversation_flow_id;
      const publishedFlows = await this.flowsService
        .getPublishedByCompany(companyId, targetFlowId)
        .catch(() => []);
      const targetFlow = publishedFlows[0];
      if (!targetFlow) {
        this.logger.error(
          `Agent transfer failed for ${callSid}: agent ${targetAgentId}'s flow ${targetFlowId} not found or not published`,
        );
        await this.handleTransferUnavailable(callSid, session, 'agent');
        return;
      }

      if (!lastAgentText) {
        const transition = this.flowTransferTransitionMessage(session, targetAgent.agentName);
        const toSpeak = await this.speakFlowResponse(session, transition);
        this.appendFlowAgentHistory(session, toSpeak);
        this.patchLastAgentHistoryText(session, toSpeak);
        await this.delay(this.FLOW_TRANSFER_TRANSITION_PAUSE_MS);
      }

      // Apply the new agent's identity before speaking anything as them.
      const agentMeta = {
        agentGlobalPrompt: targetAgent.globalPrompt ?? undefined,
        agentName: targetAgent.agentName,
      };
      session.agentGlobalPreamble = buildAgentGlobalPreambleFromMetadata(agentMeta);
      session.agentDisplayName = resolveAgentDisplayNameFromMetadata(agentMeta);
      session.conversationFlowMode = normalizeConversationFlowMode(
        targetAgent.conversationFlowMode,
      );
      session.interruptionSensitivity = targetAgent.interruptionSensitivity;
      if (targetAgent.language) {
        const lang = targetAgent.language.startsWith('en')
          ? 'en'
          : targetAgent.language.split('-')[0];
        this.setConversationLanguage(session, lang);
      }
      session.voiceConfig = this.buildVoiceConfig(
        { voiceId: targetAgent.voiceId ?? undefined },
        session.language,
      );

      await this.switchSessionToFlow(session, callState, targetFlow, companyId);

      if (callState) {
        callState.metadata ??= {};
        callState.metadata.agentId = targetAgent.id;
        callState.metadata.agentName = targetAgent.agentName;
      }
      this.logger.log(
        `🔀 Agent transfer for ${callSid} -> "${targetAgent.agentName}" (${targetAgent.id})`,
      );

      void summaryPromise
        .then(summary => {
          const entry = {
            from: fromFlowId ?? null,
            toAgentId: targetAgent.id,
            toAgentName: targetAgent.agentName,
            toFlowId: targetFlow.id,
            summary: summary || null,
            at: new Date().toISOString(),
          };
          const prior = Array.isArray(callState?.metadata?.agentTransfers)
            ? (callState.metadata.agentTransfers as unknown[])
            : [];
          const agentTransfers = [...prior, entry];
          if (callState) {
            callState.metadata ??= {};
            callState.metadata.agentTransfers = agentTransfers;
          }
          return this.callRecordService.mergeMetadata(callSid, { agentTransfers });
        })
        .catch((e: unknown) => {
          this.logger.debug(
            `Persisting agent-transfer summary failed (non-fatal) for ${callSid}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    } catch (e: unknown) {
      this.logger.error(`Agent transfer sequence failed for ${callSid}:`, e);
    } finally {
      this.flowTransfersInProgress.delete(callSid);
    }
  }

  /**
   * After audio sent, update turn state.
   * MINIMAL cool-down — just enough to prevent echo.
   */
  /**
   * Marks the start of a new agent speech attempt — see `CallSession.audioGeneration` for why this
   * exists. Call once at the top of every function that sets `turnState = 'agent-speaking'` and
   * starts streaming TTS, and use the returned id in every subsequent chunk/completion check for
   * that attempt.
   */
  private beginSpeechGeneration(session: CallSession): number {
    session.audioGeneration = (session.audioGeneration ?? 0) + 1;
    return session.audioGeneration;
  }

  private completeSpeakTextAfterAudio(
    session: CallSession,
    text: string,
    totalBytesSent: number,
    expectedGeneration: number,
  ): void {
    if (session.audioGeneration !== expectedGeneration) {
      this.logger.debug(
        `⏭️ Skipping stale speech completion for ${session.callSid} (generation ${String(expectedGeneration)} superseded by ${String(session.audioGeneration)})`,
      );
      return;
    }
    session.turnState = 'waiting-for-user';

    if (session.conversationState) {
      session.conversationState.lastAgentMessageTime = Date.now();
      session.conversationState.expectedResponseTime = Date.now();
    }

    // Open the next TTS connection now, while we wait on STT silence + LLM/flow processing for
    // the user's next turn, so that gap absorbs the ~1s ElevenLabs connect handshake instead of
    // it blocking the start of the next reply.
    if (!session.terminalTextOnly) {
      try {
        session.ttsClient.prewarm?.(session.voiceConfig);
      } catch {
        /* best-effort */
      }
    }

    // 50ms cool-down — minimal
    // setTimeout(() => {
    if (session.conversationState) {
      session.conversationState.isInCoolDown = false;
    }
    // }, 50);

    session.onTtsEnd?.(session.callSid);

    // End-call detection
    if (this.detectAgentEndCallIntent(text)) {
      this.handleAgentEndCallSignal(session.callSid, 'agent_goodbye', this.getGoodbyeDelayMs(text));
    }
    if (text.includes(DRIVER_CONFIRMATION_PHRASE)) {
      this.handleAgentEndCallSignal(
        session.callSid,
        'driver_confirmed',
        this.getGoodbyeDelayMs(text),
      );
      return;
    }
    const callState = this.callStateService.findOne(session.callSid);
    if (callState?.metadata?.language === 'no' && text.includes(VET_END_CALL_PHRASE)) {
      this.handleAgentEndCallSignal(
        session.callSid,
        'vet_booking_confirmed',
        this.getGoodbyeDelayMs(text),
      );
      return;
    }
    if (text.includes(DRIVER_CANCELLATION_PHRASE_PREFIX)) {
      void this.handleDriverCancellation(session.callSid, text);
    }
    if (session.endCallAfterFirstMessage && !session.firstMessageEndScheduled) {
      session.firstMessageEndScheduled = true;
      if (session.endCallTimeoutId) clearTimeout(session.endCallTimeoutId);
      session.endCallTimeoutId = setTimeout(() => {
        this.performEndCall(session.callSid, 'information_call_complete');
      }, this.END_CALL_AFTER_FIRST_MESSAGE_BUFFER_MS);
    }

    const xfer = session.pendingPostSpeechAction;
    if (xfer?.kind === 'pstn_transfer' && xfer.to) {
      session.pendingPostSpeechAction = undefined;
      const sid = session.callSid;
      const dest = xfer.to;
      void this.runSupportTransferSequence(sid, dest, text).catch((err: unknown) => {
        this.logger.error(`runSupportTransferSequence failed for ${sid}:`, err);
      });
    } else if (xfer?.kind === 'flow_transfer' && xfer.flowId) {
      session.pendingPostSpeechAction = undefined;
      const sid = session.callSid;
      const targetFlowId = xfer.flowId;
      void this.runFlowTransferSequence(sid, targetFlowId, text).catch((err: unknown) => {
        this.logger.error(`runFlowTransferSequence failed for ${sid}:`, err);
      });
    } else if (xfer?.kind === 'agent_transfer' && xfer.agentId) {
      session.pendingPostSpeechAction = undefined;
      const sid = session.callSid;
      const targetAgentId = xfer.agentId;
      void this.runAgentTransferSequence(sid, targetAgentId, text).catch((err: unknown) => {
        this.logger.error(`runAgentTransferSequence failed for ${sid}:`, err);
      });
    }
  }

  /**
   * Speak text with TRUE streaming — sentence by sentence.
   *
   * Each sentence is sent to TTS independently, allowing interruption
   * between sentences. First audio starts in <200ms.
   */
  private async speakText(session: CallSession, text: string, isReprompt = false): Promise<void> {
    this.logger.log(`🤖 Agent [${session.callSid}]: "${text.substring(0, 100)}..."`);

    if (!session.conversationState) {
      session.conversationState = {
        lastAgentMessageTime: 0,
        lastUserMessageTime: 0,
        consecutiveReprompts: 0,
        isInCoolDown: false,
        expectedResponseTime: 0,
      };
    }

    if (isReprompt && messageImpliesSupportHandoff(text) && !session.terminalTextOnly) {
      const dest = this.resolveSupportTransferE164(session);
      if (dest) {
        session.pendingPostSpeechAction = { kind: 'pstn_transfer', to: dest };
      }
    }

    // If reprompting, track count and add delay
    if (isReprompt) {
      session.conversationState.consecutiveReprompts++;
      // Only delay on 3rd+ reprompt, and keep minimal
      // if (session.conversationState.consecutiveReprompts > 2) {
      //   await this.delay(200);
      // }
    } else {
      session.conversationState.consecutiveReprompts = 0;
    }

    session.turnState = 'agent-speaking';
    session.agentSpeakingSince = Date.now();
    session.lastAgentResponse = text;
    session.onTtsStart?.(session.callSid);
    session.conversationState.isInCoolDown = true;
    const myGeneration = this.beginSpeechGeneration(session);

    if (session.terminalTextOnly) {
      process.stdout.write(`\nAgent: ${text}\n\n`);
      this.completeSpeakTextAfterAudio(session, text, 0, myGeneration);
      return;
    }

    // commentted for better tts
    // const chunks = this.splitIntoSpeakableChunks(text);
    // let totalBytesSent = 0;
    // let firstChunkStarted = false;
    //
    // try {
    //   for (let i = 0; i < chunks.length; i++) {
    //     // Check interruption before each chunk
    //     if (session.turnState !== 'agent-speaking') {
    //       this.logger.log(`⏹️ Speech interrupted before chunk ${i} for ${session.callSid}`);
    //       return;
    //     }
    //
    //     const chunk = chunks[i];
    //
    //     // Early end-call detection
    //     if (!firstChunkStarted) {
    //       if (this.detectAgentEndCallIntent(chunk)) {
    //         const remaining = chunks.slice(i).join(' ');
    //         this.handleAgentEndCallSignal(
    //           session.callSid,
    //           'agent_goodbye',
    //           this.getGoodbyeDelayMs(remaining),
    //         );
    //       }
    //       if (chunk.includes(DRIVER_CONFIRMATION_PHRASE)) {
    //         const remaining = chunks.slice(i).join(' ');
    //         this.handleAgentEndCallSignal(
    //           session.callSid,
    //           'driver_confirmed',
    //           this.getGoodbyeDelayMs(remaining),
    //         );
    //       }
    //       firstChunkStarted = true;
    //     }
    //
    //     // Stream this chunk to TTS
    //     const textIterator = (async function* () {
    //       yield chunk;
    //     })();
    //
    //     await session.ttsClient.streamTTS(
    //       session.voiceConfig,
    //       textIterator,
    //       async ttsChunk => {
    //         if (session.turnState !== 'agent-speaking') return;
    //         if (ttsChunk.audio?.length > 0) {
    //           totalBytesSent += ttsChunk.audio.length;
    //           this.sendAudioToTwilio(session, ttsChunk.audio);
    //         }
    //       },
    //       error => {
    //         this.logger.error(`❌ TTS chunk error for ${session.callSid}:`, error);
    //       },
    //     );
    //
    //     // 30ms gap between sentences for natural cadence + interruption window
    //     // if (i < chunks.length - 1 && session.turnState === 'agent-speaking') {
    //     //   await this.delay(30);
    //     // }
    //   }
    //
    //   // Flush remaining audio
    //   this.flushTwilioPendingAudio(session);
    //
    //   if (session.turnState === 'agent-speaking') {
    //     this.completeSpeakTextAfterAudio(session, text, totalBytesSent);
    //   }
    // replace speakText() TTS loop part only

    const chunks = this.splitIntoSpeakableChunks(text);
    let totalBytesSent = 0;

    try {
      const firstChunk = chunks[0] ?? text;

      if (this.detectAgentEndCallIntent(firstChunk)) {
        this.handleAgentEndCallSignal(
          session.callSid,
          'agent_goodbye',
          this.getGoodbyeDelayMs(text),
        );
      }

      if (firstChunk.includes(DRIVER_CONFIRMATION_PHRASE)) {
        this.handleAgentEndCallSignal(
          session.callSid,
          'driver_confirmed',
          this.getGoodbyeDelayMs(text),
        );
      }

      const textIterator = (async function* () {
        for (const chunk of chunks) {
          if (session.turnState !== 'agent-speaking' || session.audioGeneration !== myGeneration) {
            break;
          }
          yield chunk;
        }
      })();

      await session.ttsClient.streamTTS(
        session.voiceConfig,
        textIterator,
        async ttsChunk => {
          if (session.turnState !== 'agent-speaking' || session.audioGeneration !== myGeneration) {
            return;
          }

          if (ttsChunk.audio?.length > 0) {
            totalBytesSent += ttsChunk.audio.length;
            this.sendAudioToTwilio(session, ttsChunk.audio);
          }
        },
        error => {
          this.logger.error(`❌ TTS chunk error for ${session.callSid}:`, error);
        },
      );

      this.flushTwilioPendingAudio(session);
      await this.waitForQueuedAudioToDrain(session);

      if (session.turnState === 'agent-speaking' && session.audioGeneration === myGeneration) {
        this.completeSpeakTextAfterAudio(session, text, totalBytesSent, myGeneration);
      }
    } catch (error) {
      this.logger.error(`❌ TTS failed for ${session.callSid}:`, error);
      if (session.turnState === 'agent-speaking' && session.audioGeneration === myGeneration) {
        session.turnState = 'idle';
        session.conversationState.isInCoolDown = false;
        session.onTtsEnd?.(session.callSid);
      }
    }
  }

  /**
   * Split text into speakable chunks for streaming TTS.
   *
   * Splits on sentence boundaries first. Long sentences split on commas.
   * Goal: first chunk <100 chars for <200ms time-to-first-audio.
   */
  private splitIntoSpeakableChunks(text: string): string[] {
    // Split on sentence boundaries, keeping punctuation
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);

    const chunks: string[] = [];
    for (const sentence of sentences) {
      if (sentence.length <= 100) {
        chunks.push(sentence);
      } else {
        // Long sentence — split on commas for faster first audio
        const parts = sentence.split(/(?<=,)\s+/);
        let current = '';
        for (const part of parts) {
          if ((current + part).length > 80 && current) {
            chunks.push(current.trim());
            current = part;
          } else {
            current += (current ? ' ' : '') + part;
          }
        }
        if (current) chunks.push(current.trim());
      }
    }
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Handle driver cancellation (Royal Transfer)
   */
  private async handleDriverCancellation(callSid: string, text: string): Promise<void> {
    const afterPrefix = text.substring(
      text.indexOf(DRIVER_CANCELLATION_PHRASE_PREFIX) + DRIVER_CANCELLATION_PHRASE_PREFIX.length,
    );

    const endMarkers = ['. Goodbye', ' Goodbye', '\n'];
    let reasonEnd = afterPrefix.length;
    for (const m of endMarkers) {
      const i = afterPrefix.indexOf(m);
      if (i >= 0 && i < reasonEnd) reasonEnd = i;
    }
    const reason = afterPrefix.slice(0, reasonEnd).trim();

    const callState = this.callStateService.findOne(callSid);
    const bookingIdRaw = callState?.metadata?.bookingId;
    const bookingId = typeof bookingIdRaw === 'string' ? bookingIdRaw : undefined;

    this.callStateService.updateMetadata(callSid, {
      driverCancelledReason: reason || null,
    });

    if (bookingId !== undefined && this.royalTransferService) {
      this.logger.log(
        `📋 Driver cancelled booking ${bookingId}; reason: "${reason || '(none)'}". Cancelling on platform.`,
      );

      try {
        const ok = await this.royalTransferService.cancelBookingByDriver(
          bookingId,
          reason || undefined,
        );
        if (ok) this.logger.log(`✅ Booking ${bookingId} cancelled on platform`);
        else this.logger.warn(`⚠️ Failed to cancel booking ${bookingId} on platform`);
      } catch (err: any) {
        this.logger.warn(`Failed to cancel booking ${bookingId}:`, err?.message ?? err);
      }
    } else if (!bookingId) {
      this.logger.warn(`Driver cancellation detected but no bookingId for ${callSid}`);
    }

    this.handleAgentEndCallSignal(callSid, 'driver_cancelled', this.getGoodbyeDelayMs(text));
  }
  //
  // /**
  //  * Send audio to Twilio
  //  */
  // private sendAudioToTwilio(session: CallSession, audioBuffer: Buffer) {
  //   try {
  //     session.twilioWs.send(
  //       JSON.stringify({
  //         event: 'media',
  //         streamSid: session.streamSid,
  //         media: {
  //           payload: audioBuffer.toString('base64'),
  //         },
  //       }),
  //     );
  //   } catch (error) {
  //     this.logger.error(`❌ Error sending audio to Twilio for ${session.callSid}:`, error);
  //   }
  // }

  /**
   * Detect user end call intent
   */
  private detectUserEndCallIntent(transcript: string): boolean {
    const lower = transcript.toLowerCase().trim();
    return this.USER_END_CALL_PHRASES.some(phrase => lower.includes(phrase));
  }

  /**
   * Detect agent end call intent
   */
  private detectAgentEndCallIntent(text: string): boolean {
    const lower = text.toLowerCase();
    return this.AGENT_END_PHRASES.some(phrase => lower.includes(phrase));
  }

  /**
   * Handle user request to end call
   */
  private async handleUserEndCallRequest(callSid: string): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session || session.userEndCallRequested) return;

    session.userEndCallRequested = true;

    if (session.endCallTimeoutId) {
      clearTimeout(session.endCallTimeoutId);
      session.endCallTimeoutId = undefined;
    }

    // Speak goodbye
    const goodbye = 'Thank you for calling. Have a great day! Goodbye.';
    this.appendFlowAgentHistory(session, goodbye);
    await this.speakText(session, goodbye);

    this.logger.log(
      `⏱️ User end call requested for ${callSid}: ending in ${this.END_CALL_AFTER_USER_REQUEST_BUFFER_MS / 1000}s`,
    );

    const timeoutId = setTimeout(() => {
      this.performEndCall(callSid, 'user_requested');
    }, this.END_CALL_AFTER_USER_REQUEST_BUFFER_MS);

    session.endCallTimeoutId = timeoutId;
  }

  /** Spoken only when the caller explicitly asked for a human but no support number is configured at all. */
  private noHumanSupportConfiguredMessage(session: CallSession): string {
    const lang = metadataToCanonicalIso6391(session.language);
    if (lang === 'no') {
      return 'Beklager, jeg kan ikke koble deg til en person akkurat nå, men jeg gjør mitt beste for å hjelpe deg selv.';
    }
    return "I'm sorry, I'm not able to connect you with a live representative right now, but I'll do my best to help you myself.";
  }

  /**
   * Handle the caller directly asking for a human — highest-priority interrupt (see the call site
   * in `processUserTranscript`). Fires regardless of whether the call is running a flow, a script,
   * or generic AI conversation, and skips straight to the support-transfer sequence without letting
   * the current process ask another question or attempt to resolve anything first.
   */
  private async handleUserWantsHumanRequest(callSid: string, spokenText: string): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session || session.humanTransferRequested) return;

    // Nothing else recorded this turn — we're interrupting before the normal flow/script/AI path
    // (which would have pushed it) ever runs.
    const text = spokenText.trim();
    if (text) {
      if (session.isFlowCall && session.flowState) {
        const hist = session.flowState.history as { role: string; text: string; at: string }[];
        hist.push({ role: 'user', text, at: new Date().toISOString() });
      } else {
        session.conversationHistory.push({ role: 'user', content: text, timestamp: new Date() });
      }
    }

    const dest = this.resolveSupportTransferE164(session);
    if (!dest) {
      this.logger.warn(
        `User requested human transfer for ${callSid} but no support number is configured`,
      );
      const fallback = this.noHumanSupportConfiguredMessage(session);
      this.appendFlowAgentHistory(session, fallback);
      await this.speakText(session, fallback, false);
      // Nothing is in flight — let the caller (or a later retry) keep talking to the bot instead.
      return;
    }

    this.logger.log(`📞 User explicitly requested human transfer for ${callSid} -> ${dest}`);
    session.humanTransferRequested = true;
    await this.runSupportTransferSequence(callSid, dest, '');
  }

  /**
   * Handle agent signaling end of conversation
   */
  private handleAgentEndCallSignal(
    callSid: string,
    reason: string,
    delayMs: number = this.END_CALL_AFTER_GOODBYE_BUFFER_MS,
  ): void {
    const session = this.sessions.get(callSid);
    if (!session || session.agentEndCallSignaled) return;

    session.agentEndCallSignaled = true;

    if (session.endCallTimeoutId) {
      clearTimeout(session.endCallTimeoutId);
      session.endCallTimeoutId = undefined;
    }

    this.logger.log(
      `⏱️ Agent end call signaled for ${callSid} (${reason}): ending in ${delayMs / 1000}s`,
    );

    const timeoutId = setTimeout(() => {
      this.performEndCall(callSid, reason);
    }, delayMs);

    session.endCallTimeoutId = timeoutId;
  }

  /** Build transcript text for post-call inbound classification (script or flow). */
  private buildInboundTranscriptForInsight(session: CallSession): string {
    if (session.isFlowCall && session.flowState?.history?.length) {
      return session.flowState.history
        .map((h: { role: string; text?: string }) => `${h.role}: ${h.text ?? ''}`)
        .join('\n');
    }
    return session.conversationHistory
      .filter(m => m.role !== 'system')
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');
  }

  /** Max times to defer `performEndCall` while the agent is still mid-speech (see below). */
  private readonly END_CALL_SPEAKING_DEFER_MAX_ATTEMPTS = 6;
  private readonly END_CALL_SPEAKING_DEFER_MS = 500;

  /**
   * True if there's still audio queued for the phone line that hasn't been sent out yet.
   * `turnState` flips to 'waiting-for-user' as soon as all bytes have been *received* from TTS —
   * not once they've actually drained out over the 20ms-paced send loop. For a long response that
   * gap can be a couple of seconds, during which a hangup (or an immediately-following message,
   * e.g. a goodbye queued right behind it) would otherwise cut the tail of that audio short.
   */
  private hasPendingAudioToDrain(session: CallSession): boolean {
    if (session.callSid.startsWith('TLX_')) {
      return (session.telnyxPcm16Pending?.length ?? 0) > 0 || !!session.telnyxL16DrainIntervalId;
    }
    return (session.twilioMulawPending?.length ?? 0) > 0 || !!session.twilioDrainActive;
  }

  /**
   * Perform actual call termination
   */
  private performEndCall(callSid: string, reason: string, deferAttempt = 0): void {
    if (callSid.startsWith('TLX_') && this.telnyxSupportHandoffHangupSuppressed.has(callSid)) {
      this.logger.debug(
        `Skipping performEndCall (${reason}) for ${callSid} — Telnyx support transfer in progress`,
      );
      return;
    }
    this.logger.log(`🔚 Performing end call for ${callSid} (reason: ${reason})`);

    if (deferAttempt === 0) {
      // Every cleanup must be traceable to what triggered it — capture the call stack once, at
      // the first (non-deferred-retry) invocation, so a premature or unexpected end-call is
      // debuggable after the fact instead of showing up only as a bare reason string.
      this.logger.debug(
        `performEndCall stack for ${callSid} (reason: ${reason}):\n${new Error('performEndCall stack').stack ?? ''}`,
      );
    }
    const session = this.sessions.get(callSid);
    // The scheduled goodbye delay is an estimate; if TTS is still actively streaming audio (e.g.
    // it had to retry through a voice-id fallback), hanging up now would cut the agent off
    // mid-sentence — the audio would have been generated successfully but never heard. Give it a
    // short, bounded grace period to finish instead of tearing the session down underneath it.
    if (
      session != null &&
      (session.turnState === 'agent-speaking' || this.hasPendingAudioToDrain(session)) &&
      deferAttempt < this.END_CALL_SPEAKING_DEFER_MAX_ATTEMPTS
    ) {
      this.logger.log(
        `⏳ Deferring end call for ${callSid} (reason: ${reason}) — agent still speaking (attempt ${deferAttempt + 1}/${this.END_CALL_SPEAKING_DEFER_MAX_ATTEMPTS})`,
      );
      session.endCallTimeoutId = setTimeout(() => {
        this.performEndCall(callSid, reason, deferAttempt + 1);
      }, this.END_CALL_SPEAKING_DEFER_MS);
      return;
    }

    this.logger.log(`🔚 Performing end call for ${callSid} (reason: ${reason})`);

    const skipTwilioHangup = session?.terminalTextOnly === true;
    const callState = this.callStateService.findOne(callSid);
    if (session && callState?.metadata?.callType === 'inbound') {
      const transcript = this.buildInboundTranscriptForInsight(session);
      void this.inboundInsightService.persistAfterInboundCall(callSid, transcript);
    }
    if (session?.noResponseTimeoutId) {
      clearTimeout(session.noResponseTimeoutId);
    }
    if (session?.endCallTimeoutId) {
      clearTimeout(session.endCallTimeoutId);
    }
    if (session?.maxCallDurationTimeoutId) {
      clearTimeout(session.maxCallDurationTimeoutId);
    }

    this.cleanupSession(callSid);

    const alreadyTerminal =
      callState?.status === CallStatus.COMPLETED ||
      callState?.status === CallStatus.FAILED ||
      callState?.status === CallStatus.CANCELLED;
    const skipHangupCommand = this.hangupCommandSent.has(callSid) || alreadyTerminal;

    if (!skipTwilioHangup && skipHangupCommand) {
      this.logger.debug(
        `Skipping hangup command for ${callSid} — ${
          alreadyTerminal ? `call already ${callState?.status}` : 'hangup already requested'
        }`,
      );
    } else if (!skipTwilioHangup) {
      this.hangupCommandSent.set(
        callSid,
        setTimeout(() => this.hangupCommandSent.delete(callSid), 60_000),
      );
      if (callSid.startsWith('TLX_')) {
        const metaId = callState?.metadata?.telnyxCallControlId;
        const controlId = typeof metaId === 'string' && metaId !== '' ? metaId : callSid.slice(4);
        void this.telnyxClient.endCall(controlId).catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          // The provider races us here on any call the other party hangs up first — by the time
          // our own hangup request lands, Telnyx has already torn the call down. That's a normal
          // outcome, not a failure, so it doesn't belong at `warn`.
          const alreadyInactive = detail.toLowerCase().includes('no longer active');
          const log = alreadyInactive
            ? this.logger.debug.bind(this.logger)
            : this.logger.warn.bind(this.logger);
          log(`Failed to end Telnyx call ${callSid} (call_control_id=${controlId}): ${detail}`);
        });
      } else {
        void this.twilioClient.endCall(callSid).catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to end Twilio call ${callSid}:`, detail);
        });
      }
    } else {
      this.logger.log(`Skipping Twilio hangup for ${callSid} due to terminal text-only mode`);
      setTimeout(() => {
        this.logger.debug('waiting for call data to be stored in DB');
        this.callRecordService.updateStatus(callSid, 'completed').catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to update call record status for ${callSid}:`, detail);
        });
      }, 1000);
    }
  }
  /**
   * Cleanup session
   */
  private cleanupSession(callSid: string): void {
    const session = this.sessions.get(callSid);
    const onTerminalSessionEnd = session?.onTerminalSessionEnd;
    if (session) {
      this.persistCallTranscriptToRecord(callSid, session);
    }
    if (!session) return;

    try {
      session.ttsClient.abort();
    } catch {
      /* ignore */
    }

    if (session.maxCallDurationTimeoutId) {
      clearTimeout(session.maxCallDurationTimeoutId);
      session.maxCallDurationTimeoutId = undefined;
    }
    this.stopTelnyxL16MediaDrain(session);
    this.clearPendingReprompt(session);
    this.clearPendingIncompleteUtteranceHold(session);
    // this.clearNoResponseRephraseTimer(session);
    // if (session.silenceKeepaliveId) {
    //   clearInterval(session.silenceKeepaliveId);
    //   session.silenceKeepaliveId = undefined;
    // }
    // session.twilioMediaQueue = [];
    // session.twilioMediaDraining = false;
    this.sessions.delete(callSid);
    this.logger.log(`🗑️ Session cleaned up for ${callSid}. Remaining: ${this.sessions.size}`);
    onTerminalSessionEnd?.();
  }

  /**
   * Send μ-law silence to Twilio every 20ms when we're not sending TTS.
   * Keeps the media stream alive so Twilio does not close the call while the user is speaking.
   */
  // private startSilenceKeepalive(session: CallSession): void {
  //   const TWILIO_SILENCE_INTERVAL_MS = 20;
  //   const MULAW_SILENCE_BYTES = 160; // 20ms at 8kHz
  //   const mulawSilence = Buffer.alloc(MULAW_SILENCE_BYTES, 0xff);
  //   const payload = mulawSilence.toString('base64');
  //
  //   session.silenceKeepaliveId = setInterval(() => {
  //     if (session.turnState === 'agent-speaking') return;
  //     try {
  //       if (session.twilioWs.readyState === WebSocket.OPEN) {
  //         session.twilioWs.send(
  //           JSON.stringify({
  //             event: 'media',
  //             streamSid: session.streamSid,
  //             media: { payload },
  //           }),
  //         );
  //       }
  //     } catch {
  //       // ignore
  //     }
  //   }, TWILIO_SILENCE_INTERVAL_MS);
  // }

  /**
   * Render template with slots
   */
  private renderTemplate(template: string, slots: Record<string, any>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
      const value = slots[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  /**
   * Build flow config from metadata (retained from original).
   * When call language is Norwegian ('no'), uses Norwegian first message if template is empty or matches English default.
   */
  private buildFlowConfigFromMetadata(callState: any): any {
    const flow = getEffectiveFlow(callState.metadata.flow);
    const flowSlots = (flow as any).slots;
    const initialSlots = {
      ...(flowSlots && typeof flowSlots === 'object' ? flowSlots : {}),
      companyName: callState.metadata?.companyName || 'our company',
      customerName: callState.metadata?.customerName || '',
      ...callState.metadata?.initialSlots,
    };

    const startId = getStartNodeId(flow);
    const initialState = {
      flowId: callState.metadata?.flowId || 'unknown',
      currentNode: startId,
      slots: initialSlots,
      history: [],
    };

    const startNode = getNode(flow, startId);
    const startTemplate = getSayTemplate(startNode);
    let firstMessage = '';
    if (startTemplate) {
      firstMessage = this.renderTemplate(startTemplate, initialSlots);
    }

    const language = callState.metadata?.language ?? 'en';
    const scriptDirection = callState.metadata?.callType === 'outbound' ? 'outbound' : 'inbound';
    firstMessage = pickScriptFirstMessage(firstMessage || undefined, language, {
      direction: scriptDirection,
    });

    return { flow, initialState, firstMessage };
  }

  /**
   * Load flow from service (retained from original)
   */
  private async loadFlowFromService(callState: any, flowId: string): Promise<any> {
    if (!this.flowsService) {
      throw new Error('FlowsService not available');
    }

    const companyIdForFlow =
      (callState.metadata?.flowCompanyId as string | undefined) || callState.companyId;
    if (!companyIdForFlow) {
      throw new Error('flowCompanyId or companyId required to load flow');
    }

    const publishedFlows = await this.flowsService.getPublishedByCompany(companyIdForFlow, flowId);
    const publishedFlow = publishedFlows[0];

    const flowData = publishedFlow?.flow ? getEffectiveFlow(publishedFlow.flow) : undefined;
    const startId = flowData ? getStartNodeId(flowData) : undefined;
    if (!flowData || !startId) {
      throw new Error(`Invalid flow configuration for ${flowId}`);
    }

    return this.buildFlowConfigFromMetadata({
      ...callState,
      metadata: {
        ...callState.metadata,
        flow: publishedFlow.flow,
        flowId: publishedFlow.id,
      },
    });
  }

  /** True while an active voice bridge session exists for this callSid */
  hasSession(callSid: string): boolean {
    return this.sessions.has(callSid);
  }

  /**
   * Public stop method. Callers must pass a real reason — this is a cleanup/hangup trigger, and
   * every cleanup needs to be traceable back to what caused it (a stale hardcoded 'manual_stop'
   * here previously masked the true trigger — e.g. a WebSocket 'stop' frame or close event — in
   * logs, making it impossible to tell an intentional stop from an upstream failure after the fact).
   */
  stop(callSid: string, reason = 'unspecified_stop') {
    this.performEndCall(callSid, reason);
  }

  /**
   * Stop current speech immediately (for interruptions)
   */
  stopSpeech(callSid: string): void {
    const session = this.sessions.get(callSid);
    if (!session) return;

    this.logger.log(`🛑 Stopping speech for ${callSid}`);

    // Abort TTS client
    session.ttsClient.abort();

    session.pendingPostSpeechAction = undefined;

    // Reset state
    session.isProcessing = false;
    session.turnState = 'waiting-for-user';
    session.audioChunksPending = 0;

    // CRITICAL: For flow calls, mark last agent message as interrupted
    if (session.isFlowCall && session.flowState?.history?.length > 0) {
      const history = session.flowState.history;
      const lastAgentIndex = history.findLastIndex((h: any) => h.role === 'agent');

      if (lastAgentIndex !== -1 && history[lastAgentIndex].text) {
        const text = history[lastAgentIndex].text;
        // Only mark if not already marked
        if (!text.startsWith('[Interrupted]')) {
          history[lastAgentIndex].text = `[Interrupted] ${text.substring(0, 50)}...`;
        }
      }
    }

    // Notify gateway
    session.onTtsEnd?.(callSid);
  }

  /**
   * Handle partial transcript (user still speaking).
   * When agent is speaking: use current node's interruption_sensitivity to decide whether to stop agent and listen to user (keeps sync human-like).
   */
  // async processPartialTranscript(callSid: string, transcript: string): Promise<void> {
  //   const session = this.sessions.get(callSid);
  //   if (!session?.isFlowCall) return;
  //
  //   // If we're in a flow and waiting for input, just update partial (user is speaking — agent does not speak)
  //   if (session.turnContext?.isWaitingForUser) {
  //     session.turnContext.partialTranscript = transcript;
  //     return;
  //   }
  //
  //   // User already asked to end, or hangup is scheduled — do not barge-in on trailing "bye"/noise (avoids restarting goodbye TTS).
  //   if (session.userEndCallRequested || session.agentEndCallSignaled) {
  //     return;
  //   }
  //
  //   // Agent is speaking: use agent or node interruption sensitivity to decide barge-in.
  //   if (session.turnState === 'agent-speaking') {
  //     const currentNodeId = session.flowState?.currentNode ?? session.currentNodeId;
  //     const currentNode =
  //       session.currentFlow && currentNodeId ? getNode(session.currentFlow, currentNodeId) : null;
  //     const nodeSensitivity = getInterruptionSensitivity(currentNode);
  //     const agentSensitivity = session.interruptionSensitivity;
  //     const effectiveSensitivity = agentSensitivity != null ? agentSensitivity : nodeSensitivity;
  //     if (effectiveSensitivity <= 0) {
  //       this.logger.debug(
  //         `⏭️ Ignoring partial — interruption_sensitivity=${effectiveSensitivity} (no interrupt) for ${callSid}`,
  //       );
  //       return;
  //     }
  //     const trimmed = (transcript || '').trim();
  //     if (trimmed.length < 2) return;
  //     this.logger.debug(`✋ Barge-in for ${callSid}: stopping agent and listening`);
  //     this.handleInterruption(callSid, transcript);
  //   }
  // }
  // replace processPartialTranscript() with this

  async processPartialTranscript(callSid: string, transcript: string): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session) return;

    const trimmed = (transcript || '').trim();
    if (trimmed.length < 2) return;
    // STT noise/silence artifacts (e.g. "...") look like valid short partials by length alone but
    // are not real speech — don't let them barge in and kill agent audio that's mid-flight.
    if (this.isNoiseOrStaticTranscript(trimmed)) return;

    session.turnContext.partialTranscript = trimmed;
    session.turnContext.isProcessingPartial = true;

    if (!this.isEligibleForBargeIn(session, trimmed)) return;

    this.logger.debug(`✋ Realtime barge-in for ${callSid}: "${trimmed}"`);
    this.handleInterruption(callSid, trimmed);
  }

  /**
   * Shared barge-in worthiness test — used both for live partial transcripts above and, as a
   * fallback, for final transcripts that arrive while the agent is speaking without a qualifying
   * partial having fired first (see `isFinalTranscriptEligibleForBargeIn` and
   * `voice-media.gateway.ts`'s `handleTranscript`). Centralizing this keeps the tuned thresholds
   * (onset grace window, minimum length, interruption sensitivity) as one source of truth instead
   * of duplicating/drifting between the partial and final code paths.
   */
  private isEligibleForBargeIn(session: CallSession, trimmed: string): boolean {
    let nodeInterruptionSensitivity: number | undefined;
    if (session.isFlowCall) {
      const currentNodeId = session.flowState?.currentNode ?? session.currentNodeId;
      const currentNode =
        session.currentFlow && currentNodeId ? getNode(session.currentFlow, currentNodeId) : null;
      nodeInterruptionSensitivity = getInterruptionSensitivity(currentNode);
    }

    const result = evaluateBargeInEligibility(
      {
        isWaitingForUser: session.turnContext?.isWaitingForUser ?? false,
        callEnding: !!(session.userEndCallRequested || session.agentEndCallSignaled),
        turnState: session.turnState,
        interruptionSensitivity: session.interruptionSensitivity,
        nodeInterruptionSensitivity,
        agentSpeakingSince: session.agentSpeakingSince,
      },
      trimmed,
      { bargeInGraceMs: this.BARGE_IN_GRACE_MS, bargeInMinChars: this.BARGE_IN_MIN_CHARS },
    );

    if (!result.eligible && result.reason === 'sensitivity_zero') {
      this.logger.debug(
        `⏭️ Ignoring barge-in candidate — interruption_sensitivity=${String(session.interruptionSensitivity ?? nodeInterruptionSensitivity)} for ${session.callSid}`,
      );
    }
    return result.eligible;
  }

  /**
   * True when a *final* transcript arriving while the agent is speaking should be treated as a
   * real barge-in rather than dropped as echo — applies the same worthiness bar as live partials
   * (see `isEligibleForBargeIn`), so a genuine interruption that happened to finalize before a
   * qualifying partial fired isn't silently discarded.
   */
  isFinalTranscriptEligibleForBargeIn(callSid: string, transcript: string): boolean {
    const session = this.sessions.get(callSid);
    if (!session) return false;
    return this.isEligibleForBargeIn(session, (transcript || '').trim());
  }

  /**
   * Handle silence detection (user stopped speaking)
   */
  async handleSilence(callSid: string): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session?.isFlowCall) return;

    // If we have a pending partial transcript, process it as final
    if (session.turnContext?.partialTranscript && session.turnContext.isProcessingPartial) {
      const finalTranscript = session.turnContext.partialTranscript;
      session.turnContext.partialTranscript = '';
      session.turnContext.isProcessingPartial = false;

      await this.processFlowTurn(session, callSid, finalTranscript, false, false);
    }
  }

  /**
   * Check if currently speaking
   */
  isSpeaking(callSid: string): boolean {
    const session = this.sessions.get(callSid);
    return session?.turnState === 'agent-speaking' || false;
  }
}
