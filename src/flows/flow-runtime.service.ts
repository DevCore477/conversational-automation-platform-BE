import { Injectable, BadRequestException, Logger } from '@nestjs/common';

import { AgentResponseVerificationService } from './agent-response-verification.service';
import {
  ConversationFlowToolExecutorService,
  type FlowToolExecutionContext,
} from './conversation-flow-tool-executor.service';
import {
  getStartNodeId,
  getNode,
  getSayTemplate,
  getSayPrompt,
  getSayText,
  getListen,
  getTransitions,
  isEndNode,
  isTransferCallNode,
  getIntents,
  getEdgesForNode,
  getFlowToolDefinitions,
  getFlowSlotDefinition,
  getBasketDoneDestination,
  isToolNodeAt,
  type NormalizedNode,
  type FlowNodeLegacy,
} from './flow-accessors';
import {
  extractSlotWithContext,
  fastExtractConfiguredSlot,
  fastExtractFromFlowSlotDefinition,
  findProductMentionInFlow,
  formatSlotDefForLlm,
  hasOrderItemsInSlots,
  isDoneOrderingPhrase,
  isNegatedOrderMorePhrase,
  isReadyToOrderPhrase,
  isStructuredMenuSlot,
  normalizeSlotValue,
  normalizeSttTranscript,
  resolveGlobalIntentDestination,
  resolveNextNodeBySlotValue,
  userDeclinedOptionalSlotInContext,
} from './slot-extraction.util';
import { OpenAIClient } from '../clients/openai/openai.client';
import { formatUtteranceContextForFlowPrompt } from '../voice/utterance-interpreter.util';
import { OpenAIModel } from '../common/enums';
import type { ConversationFlowMode } from '../agents/types/conversation-flow-mode.types';
import { normalizeConversationFlowMode } from '../agents/types/conversation-flow-mode.types';
import { ConversationFlowJSON, ToolNode, TurnContext, isNewFlowFormat } from './types/flows.types';
import type { AgentResponseVerificationInput } from './types/agent-response-verification.types';
import {
  defaultScriptOpeningMessage,
  languageInstructionForRepromptLlm,
  metadataToCanonicalIso6391,
  outboundDefaultScriptOpeningMessage,
} from '../voice/call-language';
import {
  type ConversationChannel,
  adaptFlowTextForChannel,
  channelAgentRules,
  defaultFlowFallbackReply,
  defaultFlowGoodbye,
  defaultFlowOpening,
} from './conversation-channel.types';

interface FlowHistoryItem {
  role: 'agent' | 'user';
  text: string;
  at: string;
}

function nowIso() {
  return new Date().toISOString();
}

type FlowSlots = Record<string, unknown>;

function slotValueToString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function renderTemplate(template: string, vars: FlowSlots) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    return slotValueToString(vars[key]);
  });
}

function matchIntentSimple(
  intents: ConversationFlowJSON['intents'] | undefined,
  text: string,
  scope?: string[],
): { intent: string; confidence: 'high' | 'low' } | null {
  if (!intents) return null;
  const t = normalizeSttTranscript(text).toLowerCase().trim();

  if (t.length === 0) return null;

  const keys = scope?.length ? scope : Object.keys(intents);
  const intentMap = intents as Record<string, { rules: string[] } | undefined>;

  // First pass: exact match or starts with (high confidence)
  for (const k of keys) {
    const entry = intentMap[k];
    if (entry === undefined) continue;
    const rules = entry.rules;
    for (const r of rules) {
      const ruleLower = r.toLowerCase().trim();
      if (t === ruleLower || t.startsWith(`${ruleLower} `)) {
        return { intent: k, confidence: 'high' };
      }
    }
  }

  // Second pass: includes or word boundary (lower confidence)
  for (const k of keys) {
    const entry = intentMap[k];
    if (entry === undefined) continue;
    if (k === 'order_more' && isNegatedOrderMorePhrase(text)) continue;
    const rules = entry.rules;
    for (const r of rules) {
      const ruleLower = r.toLowerCase().trim();
      if (
        t.includes(ruleLower) ||
        new RegExp(`\\b${ruleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)
      ) {
        return { intent: k, confidence: 'low' };
      }
    }
  }

  return null;
}

@Injectable()
export class FlowRuntimeService {
  private readonly logger = new Logger(FlowRuntimeService.name);

  constructor(
    private readonly openaiClient: OpenAIClient,
    private readonly verificationService: AgentResponseVerificationService,
    private readonly flowToolExecutor: ConversationFlowToolExecutorService,
  ) {}

  /**
   * Builds the first message for the flow, including dynamic slot rendering.
   * When there is no start template, uses a localized default for the call language.
   */
  buildFirstMessage(
    flow: ConversationFlowJSON,
    slots: FlowSlots,
    language?: string,
    options?: { treatAsOutbound?: boolean; channel?: ConversationChannel },
  ): string {
    const node = getNode(flow, getStartNodeId(flow));
    const template = getSayTemplate(node);
    if (!template) {
      if (options?.channel === 'whatsapp') {
        return defaultFlowOpening('whatsapp');
      }
      const lang = metadataToCanonicalIso6391(language);
      return options?.treatAsOutbound
        ? outboundDefaultScriptOpeningMessage(lang)
        : defaultScriptOpeningMessage(lang);
    }
    const rendered = renderTemplate(template, slots);
    return options?.channel === 'whatsapp' ? adaptFlowTextForChannel(rendered, 'whatsapp') : rendered;
  }

  private getExtractionGuidance(slotName: string, slotType: string): string {
    switch (slotType) {
      case 'appointment_time':
        return 'Focus on extracting appointment times, which may include both the doctor\'s name and the time (e.g., "Dr. Bilal at 2 pm").';
      case 'time':
        return 'Focus on extracting time expressions (e.g., "2 pm", "next Monday", "tomorrow morning").';
      case 'name':
        return 'Focus on extracting names, especially proper nouns or possessive forms (e.g., "Dr. Bilal", "Max", "Alice\'s name").';
      case 'location':
        return 'Focus on extracting location names or addresses.';
      default:
        return 'Extract the relevant information based on the slot name and context.';
    }
  }

  private inferSlotType(slotName: string): string {
    const lowerName = slotName.toLowerCase();
    if (
      lowerName.includes('appointment') ||
      (lowerName.includes('name') && lowerName.includes('time'))
    ) {
      return 'appointment_time';
    }
    if (lowerName.includes('time') || lowerName.includes('date')) {
      return 'time';
    }
    if (lowerName.includes('name')) {
      return 'name';
    }
    if (lowerName.includes('location') || lowerName.includes('address')) {
      return 'location';
    }
    return 'general';
  }

  /**
   * FIXED: Returns object with isTrigger and matchedIntent
   */
  private checkIntentTrigger(
    text: string,
    node: NormalizedNode | FlowNodeLegacy | null,
    flow: ConversationFlowJSON,
    conversationFlowMode: ConversationFlowMode = 'rigid',
  ): { isTrigger: boolean; matchedIntent?: string } {
    const t = text.toLowerCase().trim();

    const listen = getListen(node);
    const intentScope = listen?.intent_scope;
    const intents = getIntents(flow);

    let matchedIntent: string | null = null;

    const keysToCheck =
      intents && conversationFlowMode === 'flex'
        ? Object.keys(intents as Record<string, unknown>)
        : intentScope;

    if (intents && keysToCheck?.length) {
      const intentMap = intents as Record<string, { rules: string[] } | undefined>;
      for (const intentKey of keysToCheck) {
        const intent = intentMap[intentKey];
        if (intent === undefined || intent.rules.length === 0) continue;

        for (const rule of intent.rules) {
          const ruleLower = rule.toLowerCase().trim();
          // Exact match or starts with
          if (t === ruleLower || t.startsWith(`${ruleLower} `)) {
            matchedIntent = intentKey;
            break;
          }
          // For short inputs, also check if rule contains the text
          if (t.length <= 4 && ruleLower.includes(t)) {
            matchedIntent = intentKey;
            break;
          }
        }
        if (matchedIntent) break;
      }
    }

    const listenCfg = getListen(node);
    const sayTemplate = getSayTemplate(node);
    const sayText = getSayText(node);
    const expectsConfirmation =
      (listenCfg?.capture_slot?.toLowerCase().includes('confirm') ?? false) ||
      (sayTemplate?.toLowerCase().includes('confirm') ?? false) ||
      /\b(is that|does that|will that|correct|right)\b/i.test(sayText);

    // Common confirmation words
    const confirmationWords = ['yes', 'no', 'yeah', 'nah', 'yep', 'nope', 'sure', 'ok', 'okay'];

    // If expecting confirmation, "yes"/"no" are slot values, NOT intent triggers
    if (expectsConfirmation && confirmationWords.includes(t)) {
      return { isTrigger: false };
    }

    // If it matches an intent AND is a short confirmation word
    if (matchedIntent && confirmationWords.includes(t)) {
      return { isTrigger: true, matchedIntent };
    }

    // For non-confirmation slots, short words without intent match might still be data
    if (!expectsConfirmation && t.length <= 3 && confirmationWords.includes(t)) {
      // Only trigger if we actually have a matching intent
      if (matchedIntent) {
        return { isTrigger: true, matchedIntent };
      }
    }

    return { isTrigger: false };
  }

  // private isGarbageInput(text: string): boolean {
  //   const lower = text.toLowerCase().trim();
  //
  //   // Allow short valid responses
  //   if (['yes', 'no', 'ok', 'hi', 'yeah', 'yep', 'nope', 'nah', 'sure'].includes(lower)) {
  //     return false;
  //   }
  //
  //   const garbagePatterns = [
  //     /^you$/,
  //     /^the$/,
  //     /^a$/,
  //     /^it$/,
  //     /^that$/,
  //     /if you found the video useful/,
  //     /please subscribe.*like.*comment/,
  //     /thank you for watching/i,
  //     /^\s*[\.\,\?\!]+\s*$/,
  //   ];
  //
  //   return garbagePatterns.some(p => p.test(lower));
  // }

  private fastExtract(slotType: string, text: string): string | null {
    const patterns: Record<string, RegExp[]> = {
      appointment_time: [
        /(dr\.?\s*\w+.*?(?:at|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
        /(\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*(?:with|for)?\s*dr\.?\s*\w+)/i,
        /(dr\.?\s*\w+)/i,
      ],
      doctor_name: [/(?:dr\.?|doctor)\s*(\w+)/i, /(?:with|see|for)\s+(?:dr\.?|doctor)?\s*(\w+)/i],
      pet_name: [
        /(?:name is|named|called)\s+(\w+)/i,
        /(?:my pet|my dog|my cat|the)\s+(?:is\s+)?(\w+)/i,
        /^(\w+)$/i,
      ],
      time: [
        /(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
        /(tomorrow|today|next \w+|morning|afternoon|evening)/i,
      ],
    };

    const typePatterns = patterns[slotType] ?? [];
    for (const pattern of typePatterns) {
      const match = text.match(pattern);
      if (match) {
        return (match[1] || match[0]).trim();
      }
    }
    return null;
  }

  private extractPartial(slotType: string, text: string): string | null {
    const words = text.split(/\s+/).slice(0, 5);

    if (slotType === 'appointment_time' || slotType === 'time') {
      const timeMatch = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(words.join(' '));
      if (timeMatch) return timeMatch[1];
    }

    if (slotType === 'name' || slotType === 'doctor_name' || slotType === 'pet_name') {
      const properNouns = words.filter(w => w.length > 0 && w.startsWith(w[0].toUpperCase()));
      if (properNouns.length > 0) return properNouns[0];
    }

    return null;
  }

  private readonly EXTRACTION_TIMEOUT_MS = 4000;
  private readonly MAX_REPROMPTS = 2; // Max times to reprompt before fallback

  /**
   * AI extraction with support for compound slots (e.g. doctor + time) and partial context.
   * When lastAgentMessage refers to a follow-up (e.g. "Which time for Dr. Bilal?"), combine user reply with that context.
   */
  private async aiExtract(
    slotName: string,
    userTranscript: string,
    nodeContext: string | undefined,
    slotType: string,
    options?: { lastAgentMessage?: string; slotDefHint?: string; utteranceHint?: string },
  ): Promise<string | null> {
    const slotDesc = this.getSlotDescription(slotName);
    const followUpContext = options?.lastAgentMessage?.trim()
      ? `\nLAST AGENT MESSAGE (may be a follow-up for missing info; combine with USER SAID to form full value):\n"${options.lastAgentMessage.slice(0, 300)}"`
      : '';
    const slotMenuHint = options?.slotDefHint?.trim()
      ? `\nVALID VALUES FOR THIS SLOT:\n${options.slotDefHint}`
      : '';
    const multilingualHint = options?.utteranceHint?.trim()
      ? `\n${options.utteranceHint.trim()}\n`
      : '';

    const prompt = `You are extracting the exact information the agent asked for in a phone call.

WHAT THE AGENT ASKED (use this to understand what to extract; may list options like doctors and times):
"${nodeContext ?? slotDesc}"
${followUpContext}${slotMenuHint}${multilingualHint}

USER SAID: "${userTranscript}"

EXTRACTION RULES:
1. Return ONLY the extracted value, no explanation. Maximum 15 words.
2. Remove filler words ("I want", "please", "um", "like").
3. If the agent asked for BOTH things (e.g. doctor name AND time slot) and the user gave only ONE (e.g. only "Dr. Bilal" or only "2 pm"), return NOT_FOUND so the agent can ask for the missing part.
4. If LAST AGENT MESSAGE was a follow-up (e.g. "Which time for Dr. Bilal?") and the user now gave the missing part (e.g. "Saturday 1pm"), combine: output "Dr. Bilal at Saturday 1pm" (or equivalent).
5. For appointments when both parts present: use "Dr. Name at Time" or "Name at Time" format.
6. If value not found, user gave only partial info, or short confirmation ("yes"/"no"), return exactly: NOT_FOUND
7. When VALID VALUES lists menu options, return the closest canonical menu name (typos/homophones OK, e.g. "small wrap" → Smol Wrap). Do not return NOT_FOUND when a menu item is clearly named.

EXAMPLES:
"I want to book Dr. Bilal at 2 pm" → "Dr. Bilal at 2 pm"
"My dog is named Max" → "Max"
"Dr. Bilal" (and agent asked for doctor AND time) → NOT_FOUND
"Saturday 1pm" (and last agent said "Which time for Dr. Bilal?") → "Dr. Bilal at Saturday 1pm"
"yes" / "no thanks" / "that's it" → NOT_FOUND

Extracted value:`;

    const result = await this.openaiClient.chatCompletion(
      [
        {
          role: 'system',
          content:
            'You extract specific data from phone transcripts. If the user gave only part of what was asked (e.g. only doctor, not time), return NOT_FOUND. If this is a follow-up and they gave the missing part, combine with context and return the full value.',
        },
        { role: 'user', content: prompt },
      ],
      OpenAIModel.GPT_4O_MINI,
      {
        temperature: 0.0,
        maxTokens: 50,
      },
    );

    const clean = result.trim();
    if (!clean || clean === 'NOT_FOUND' || clean.length < 2) {
      return null;
    }

    return clean;
  }

  /**
   * Extract slot value with improved timeout handling.
   * Pass lastAgentMessage when the previous turn was a follow-up (e.g. "Which time for Dr. Bilal?") so we can combine with user's reply.
   */
  public async extractSlotValue(
    slotName: string,
    userTranscript: string,
    nodeContext: string | undefined,
    node: NormalizedNode | FlowNodeLegacy | null,
    flow: ConversationFlowJSON,
    options?: {
      lastAgentMessage?: string;
      conversationFlowMode?: ConversationFlowMode;
      utteranceHint?: string;
    },
  ): Promise<string | null> {
    // Check if this is an intent trigger (but not if we're expecting confirmation)
    const triggerCheck = this.checkIntentTrigger(
      userTranscript,
      node,
      flow,
      options?.conversationFlowMode ?? 'rigid',
    );

    if (triggerCheck.isTrigger) {
      const listenCfg = getListen(node);
      const tmpl = getSayTemplate(node);
      const expectsConfirmation =
        (listenCfg?.capture_slot?.toLowerCase().includes('confirm') ?? false) ||
        (tmpl?.toLowerCase().includes('confirm') ?? false) ||
        /\b(is that|does that|will that|correct|right)\b/i.test(tmpl ?? '');

      if (!expectsConfirmation) {
        return null; // Signal that this should be handled as intent
      }
    }

    if (this.isGarbageInput(userTranscript)) {
      this.logger.warn(
        `🗑️ Garbage input rejected for "${slotName}": "${userTranscript.substring(0, 50)}..."`,
      );
      return null;
    }

    const slotType = this.inferSlotType(slotName);
    const slotDef = getFlowSlotDefinition(flow, slotName);

    try {
      const configuredFast = extractSlotWithContext(slotName, userTranscript, slotDef);
      if (configuredFast) {
        this.logger.log(`⚡ Flow-config fast extracted "${slotName}": "${configuredFast}"`);
        return configuredFast;
      }

      const fastResult = this.fastExtract(slotType, userTranscript);
      if (fastResult) {
        this.logger.log(`⚡ Fast extracted "${slotName}": "${fastResult}"`);
        return fastResult;
      }

      // Menu slots: try AI interpretation, then map through aliases/choices
      if (isStructuredMenuSlot(slotDef)) {
        const slotDefHint = formatSlotDefForLlm(slotDef);
        const aiMenu = await Promise.race([
          this.aiExtract(slotName, userTranscript, nodeContext, slotType, {
            lastAgentMessage: options?.lastAgentMessage,
            slotDefHint,
            utteranceHint: options?.utteranceHint,
          }),
          new Promise<string | null>(resolve => {
            setTimeout(() => resolve(null), this.EXTRACTION_TIMEOUT_MS);
          }),
        ]);
        if (aiMenu) {
          const mapped =
            fastExtractFromFlowSlotDefinition(slotDef, aiMenu) ??
            fastExtractFromFlowSlotDefinition(slotDef, userTranscript);
          if (mapped) {
            this.logger.log(`🤖 AI+alias mapped "${slotName}": "${mapped}"`);
            return mapped;
          }
        }
        return null;
      }

      // AI extraction with timeout (pass last agent message for combining follow-up answers)
      const slotDefHint = formatSlotDefForLlm(slotDef);
      const extractionPromise = this.aiExtract(slotName, userTranscript, nodeContext, slotType, {
        lastAgentMessage: options?.lastAgentMessage,
        slotDefHint,
        utteranceHint: options?.utteranceHint,
      });
      const timeoutPromise = new Promise<string | null>(resolve => {
        setTimeout(() => {
          const partial = this.extractPartial(slotType, userTranscript);
          this.logger.warn(`⏱️ AI timeout for "${slotName}", using partial: "${String(partial)}"`);
          resolve(partial);
        }, this.EXTRACTION_TIMEOUT_MS);
      });
      return await Promise.race([extractionPromise, timeoutPromise]);
    } catch (error) {
      this.logger.error(`❌ Extraction error for "${slotName}":`, error);
      return null;
    }
  }

  /**
   * Improved garbage input detection
   */
  private isGarbageInput(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // Allow short valid responses
    if (['yes', 'no', 'ok', 'hi', 'yeah', 'yep', 'nope', 'nah', 'sure'].includes(lower)) {
      return false;
    }

    // Reject common non-informative phrases
    const garbagePatterns = [
      /^you$/,
      /^the$/,
      /^a$/,
      /^it$/,
      /^that$/,
      /^so$/,
      /^okay$/,
      /^i'm not gonna lie/,
      /^i see$/,
      /^right$/,
      /if you found the video useful/,
      /please subscribe.*like.*comment/,
      /thank you for watching/i,
      /^\s*[.,?!]+\s*$/,
    ];

    return garbagePatterns.some(p => p.test(lower));
  }

  /** True if user said only a short greeting (hello, hi, hey) — don't rephrase; wait for real answer. */
  private isShortGreetingOnly(text: string): boolean {
    const lower = text.toLowerCase().trim();
    const greetings = ['hello', 'hi', 'hey', 'hi there', 'hello there', 'hey there', 'hola'];
    if (greetings.includes(lower)) return true;
    if (/^(hello|hi|hey)[\s.!]*$/i.test(lower)) return true;
    return false;
  }

  /** Edges that mean "caller is done / satisfied / no more help" — short verbal acknowledgments count. */
  private conditionAsksIfUserIsDoneOrSatisfied(condition: string): boolean {
    const c = condition.toLowerCase();
    return (
      /\bdone\b/.test(c) ||
      /\bsatisfied\b/.test(c) ||
      /\bdoes not need\b/.test(c) ||
      /\bnothing else\b/.test(c) ||
      /\bno further\b/.test(c) ||
      /\b(anything|something)\s+else\b/.test(c) ||
      /\b(questions?|help)\b.*\b(else|more)\b/.test(c) ||
      /\b(else|more)\b.*\b(questions?|help)\b/.test(c)
    );
  }

  private conditionAsksIfUserIsReadyToOrder(condition: string): boolean {
    const c = condition.toLowerCase();
    return (
      /\bready to order\b/.test(c) ||
      /\bwants to place an order\b/.test(c) ||
      /\bplace an order\b/.test(c)
    );
  }

  /** Brief backchannels that mean "I'm good / go ahead / thanks" on a phone call. */
  private isBriefAffirmativeOrClosingAcknowledgment(text: string): boolean {
    const raw = text.replace(/\u2019/g, "'").trim();
    const t = raw.toLowerCase();
    if (t.length === 0 || t.length > 80) return false;

    const oneLiners = new Set([
      'yes',
      'yeah',
      'yep',
      'yup',
      'no',
      'nope',
      'ok',
      'okay',
      'sure',
      'fine',
      'great',
      'cool',
      'perfect',
      'thanks',
      'thank you',
      'cheers',
      'alright',
      'all right',
      'got it',
      'mhm',
      'mhmm',
      'mm-hmm',
      'mm hmm',
      'uh-huh',
      'uh huh',
      'hmm',
      'hm',
      'right',
      'sounds good',
      'that works',
      'all good',
      "we're good",
      'were good',
      'im good',
      "i'm good",
      'all set',
      'no thanks',
      'no thank you',
      "that's all",
      'thats all',
    ]);
    if (oneLiners.has(t)) return true;

    if (/^(mm+|mhm+|uh[- ]?huh)\.?$/i.test(raw)) return true;
    if (/^(no,?\s+)?(thanks?|thank you)(\.|,|\s|$)/i.test(t)) return true;
    if (
      /^(yeah|yep|ok|sure),?\s+(that'?s|we'?re)\s+(fine|good|all set|perfect)(\.|,|\s|$)/i.test(t)
    )
      return true;

    return false;
  }

  /**
   * Generic verification: whether the user's reply fully satisfies the chosen edge condition (any domain).
   * Catches partial answers when the condition implicitly requires multiple pieces of information.
   */
  private async userReplyFullySatisfiesEdgeCondition(
    agentContext: string,
    userTranscript: string,
    edgeCondition: string,
    flow?: ConversationFlowJSON,
    captureSlotName?: string,
    conversationFlowMode: ConversationFlowMode = 'rigid',
  ): Promise<boolean> {
    if (
      flow &&
      captureSlotName &&
      fastExtractConfiguredSlot(flow, captureSlotName, userTranscript)
    ) {
      return true;
    }

    if (
      flow &&
      userDeclinedOptionalSlotInContext(
        flow,
        captureSlotName,
        agentContext,
        edgeCondition,
        userTranscript,
      )
    ) {
      return true;
    }

    if (
      this.conditionAsksIfUserIsDoneOrSatisfied(edgeCondition) &&
      this.isBriefAffirmativeOrClosingAcknowledgment(userTranscript)
    ) {
      return true;
    }

    if (
      this.conditionAsksIfUserIsReadyToOrder(edgeCondition) &&
      isReadyToOrderPhrase(userTranscript)
    ) {
      return true;
    }

    const ctx = agentContext.slice(0, 1500);
    const flexRule =
      conversationFlowMode === 'flex'
        ? '- FLEX MODE: Accept reasonably clear indirect or conversational phrasing as satisfying the condition. Still answer NO if the reply is clearly off-topic, unrelated to what was asked, or does not address it at all.'
        : '- If the reply is off-topic, unclear, or does not address what the agent asked, answer NO.';
    const prompt = `You judge if a phone caller's reply FULLY satisfies a single flow transition condition.

AGENT CONTEXT (what was asked or said; may list options): "${ctx}"
USER REPLY: "${userTranscript}"
CONDITION THAT MUST BE MET TO FOLLOW THIS BRANCH: "${edgeCondition}"

Rules:
- If the condition requires several distinct pieces of information, choices, or details, the user must clearly provide ALL of them in this reply (or pick one complete bundled option). Giving only part of what was asked is NOT satisfied.
- If the condition needs only one clear act (e.g. confirm/deny, single yes/no, one simple fact) and they gave it, it is satisfied.
${flexRule}

Answer with exactly YES or NO.`;

    try {
      const result = await this.openaiClient.chatCompletion(
        [
          { role: 'system', content: 'Reply with exactly YES or NO.' },
          { role: 'user', content: prompt },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0, maxTokens: 5 },
      );
      const upper = result.trim().toUpperCase();
      return upper.startsWith('Y');
    } catch (err) {
      this.logger.warn('Edge condition verification failed; allowing selected edge:', err);
      return true;
    }
  }

  /**
   * Use AI to pick which edge condition the user's response satisfies. Used for new flow format: each edge has a condition and destination_node_id.
   * Returns destination_node_id when one condition clearly matches, otherwise null.
   */
  private async selectEdgeByLLM(
    flow: ConversationFlowJSON,
    currentNodeId: string,
    userTranscript: string,
    node: NormalizedNode | FlowNodeLegacy | null,
    slots: FlowSlots,
    recentHistory?: FlowHistoryItem[],
    conversationFlowMode: ConversationFlowMode = 'rigid',
    utteranceHint?: string,
  ): Promise<string | null> {
    const edges = getEdgesForNode(flow, currentNodeId);
    if (!edges || edges.length === 0) return null;

    const agentAsked = node ? this.getRenderedSayContext(node, slots) : '';
    const contextLimit = 1200;
    const agentContext = (agentAsked !== '' ? agentAsked : 'N/A').slice(0, contextLimit);

    const conversationContext =
      recentHistory && recentHistory.length > 0
        ? `Recent conversation:\n${recentHistory
            .map(h => `${h.role === 'agent' ? 'Agent' : 'User'}: ${h.text}`)
            .join('\n')}\n\n`
        : '';

    const edgeLines = edges.map((e, i) => {
      const destNode = getNode(flow, e.destination_node_id);
      const leadsToEnd = destNode ? isEndNode(destNode) : false;
      const leadsToTransfer = destNode ? isTransferCallNode(destNode) : false;
      const tag = leadsToEnd ? ' [ENDS CALL]' : leadsToTransfer ? ' [TRANSFERS TO HUMAN]' : '';
      return `${String(i + 1)}. "${e.condition}" → ${e.destination_node_id}${tag}`;
    });

    // const partialInfoRule =
    //   conversationFlowMode === 'flex'
    //     ? `- FLEX MODE: Match the best-fitting condition when the user's intent is reasonably clear, even if phrasing is indirect. Use NONE only when the reply is clearly off-topic or unusable.`
    const captureSlot = getListen(node)?.capture_slot;
    const captureSlotDef = captureSlot ? getFlowSlotDefinition(flow, captureSlot) : undefined;
    const menuHint =
      captureSlot && isStructuredMenuSlot(captureSlotDef)
        ? `\nThe agent is collecting: "${captureSlot}". ${formatSlotDefForLlm(captureSlotDef)}. If the user's reply names one of these options (including typos), match the condition that accepts that choice.\n`
        : '';

    const partialInfoRule =
      captureSlot && isStructuredMenuSlot(captureSlotDef)
        ? `- This step expects ONE menu choice (or a clear yes/no). Match when the user clearly picked an option or answered the question, even with informal phrasing or typos.`
        : `- CRITICAL: If a condition requires multiple distinct pieces of information in one answer, reply NONE unless the user clearly provided ALL of them. Partial answers are not a match — reply NONE so the agent can reprompt.`;

    const multilingualBlock = utteranceHint?.trim() ? `${utteranceHint.trim()}\n` : '';

    const prompt = `You are classifying a phone user's response against the flow's possible next-step conditions. Each condition leads to a specific next node.
${menuHint}
${multilingualBlock}
${conversationContext}What the agent just asked or said (full context): "${agentContext}"
User's response: "${userTranscript}"

Conditions from the flow (pick at most ONE that the user's response clearly satisfies, or NONE):
${edgeLines.join('\n')}

Rules:
- Match the user's response to the condition that best fits. Use the condition text as the source of truth.
${partialInfoRule}
- For conditions that [ENDS CALL]: match ONLY when the user clearly indicates they want to finish the call (e.g. "yes", "that's all", "we're done", "goodbye", "thank you that's all", "sure", "okay"). Do NOT match when the user said they don't have something, don't know, can't provide, or are declining to give information (e.g. "no i don't have the availability" = NONE for end-the-call).
- For conditions that [TRANSFERS TO HUMAN]: match ONLY when the user is clearly asking for a human/agent/representative, or the condition's own wording is otherwise satisfied — do not match speculatively.
- Confirmations (yes, sure, okay) match "user confirms" or similar. Declines (no, cancel) match "user declines" or "another request".
- If the user provided the kind of information asked for, match the corresponding "provided" or "selected" condition.
- If none of the conditions clearly match (off-topic, unclear, or didn't answer), reply with exactly: NONE
- Reply with ONLY the condition number (1, 2, 3, ...) or NONE. No other text.`;

    try {
      const result = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content:
              'You output only a condition number (1, 2, 3...) or the word NONE. No explanation.',
          },
          { role: 'user', content: prompt },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: conversationFlowMode === 'flex' ? 0.25 : 0.1, maxTokens: 10 },
      );
      const raw = result.trim().toUpperCase();
      this.logger.debug(
        `LLM edge selection raw output: "${raw}" for user response: "${userTranscript}" with agent context: "${agentContext}" and conditions: ${edgeLines.join('\n')}`,
      );
      if (raw === 'NONE' || !raw) return null;
      const num = parseInt(raw.replace(/[^\d]/g, ''), 10);
      if (num >= 1 && num <= edges.length) {
        const dest = edges[num - 1].destination_node_id;
        this.logger.log(
          `🎯 LLM edge selection: condition ${String(num)} "${edges[num - 1].condition}" -> "${dest}"`,
        );
        return dest;
      }
    } catch (err) {
      this.logger.warn('LLM edge selection failed:', err);
    }
    return null;
  }

  //   /**
  //    * AI extraction with better prompting
  //    */
  //   private async aiExtract(
  //     slotName: string,
  //     userTranscript: string,
  //     nodeContext: string | undefined,
  //     slotType: string,
  //   ): Promise<string | null> {
  //     const prompt = `Extract ONLY the ${this.getSlotDescription(slotName)} from this phone conversation response.
  //
  // AGENT ASKED: "${nodeContext ?? 'for information'}"
  //
  // USER SAID: "${userTranscript}"
  //
  // EXTRACTION RULES:
  // 1. Return ONLY the extracted value, no explanation
  // 2. Remove filler words ("I want", "please", "um", "like")
  // 3. For appointments: preserve "Dr. Name at Time" format if both present
  // 4. If value not found or user just says "yes"/"no"/short confirmation, return exactly: NOT_FOUND
  // 5. Maximum 10 words
  //
  // EXAMPLES:
  // Input: "I want to book Dr. Bilal at 2 pm" → Output: "Dr. Bilal at 2 pm"
  // Input: "My dog is named Max" → Output: "Max"
  // Input: "yes" → Output: NOT_FOUND
  // Input: "no thanks" → Output: NOT_FOUND
  //
  // Extracted value:`;
  //
  //     const result = await this.openaiClient.chatCompletion(
  //       [
  //         {
  //           role: 'system',
  //           content:
  //             'You extract specific data from phone transcripts. Be strict: if uncertain or user gives short confirmation, return NOT_FOUND.',
  //         },
  //         { role: 'user', content: prompt },
  //       ],
  //       OpenAIModel.GPT_4O_MINI,
  //       {
  //         temperature: 0.0,
  //         maxTokens: 30,
  //       },
  //     );
  //
  //     const clean = result?.trim();
  //     if (!clean || clean === 'NOT_FOUND' || clean.length < 2) {
  //       return null;
  //     }
  //
  //     return clean;
  //   }

  // /**
  //  * FIXED: Properly handle yes/no as slot values when expecting confirmation
  //  */
  // public async extractSlotValue(
  //   slotName: string,
  //   userTranscript: string,
  //   nodeContext: string | undefined,
  //   node: any,
  //   flow: ConversationFlowJSON,
  // ): Promise<string | null> {
  //   // Check if this is an intent trigger (but not if we're expecting confirmation)
  //   const triggerCheck = this.checkIntentTrigger(userTranscript, node, flow);
  //
  //   // If it's a trigger and node doesn't expect confirmation, skip extraction
  //   if (triggerCheck.isTrigger) {
  //     const expectsConfirmation =
  //       node?.listen?.capture_slot?.toLowerCase().includes('confirm') ||
  //       node?.say?.template?.toLowerCase().includes('confirm') ||
  //       /\b(is that|does that|will that|correct|right)\b/i.test(node?.say?.template || '');
  //
  //     if (!expectsConfirmation) {
  //       return null; // Signal that this should be handled as intent
  //     }
  //   }
  //
  //   if (this.isGarbageInput(userTranscript)) {
  //     this.logger.warn(
  //       `🗑️ Garbage input rejected for "${slotName}": "${userTranscript.substring(0, 50)}..."`,
  //     );
  //     return null;
  //   }
  //
  //   const slotType = this.inferSlotType(slotName);
  //
  //   try {
  //     const fastResult = this.fastExtract(slotType, userTranscript);
  //     if (fastResult) {
  //       this.logger.log(`⚡ Fast extracted "${slotName}": "${fastResult}"`);
  //       return fastResult;
  //     }
  //
  //     const extractionPromise = this.aiExtract(slotName, userTranscript, nodeContext, slotType);
  //     const timeoutPromise = new Promise<string | null>(resolve => {
  //       setTimeout(() => {
  //         const partial = this.extractPartial(slotType, userTranscript);
  //         this.logger.warn(`⏱️ AI timeout for "${slotName}", using partial: "${partial}"`);
  //         resolve(partial);
  //       }, 3500);
  //     });
  //
  //     return await Promise.race([extractionPromise, timeoutPromise]);
  //   } catch (error) {
  //     this.logger.error(`❌ Extraction error for "${slotName}":`, error);
  //     return null;
  //   }
  // }

  /**
   * CORE FIX: Completely rewritten next() method with proper flow transitions
   */
  async next(params: {
    flow: ConversationFlowJSON;
    state: {
      currentNode: string;
      slots: FlowSlots;
      history: FlowHistoryItem[];
      turnContext?: TurnContext; // Add this
    };
    userTranscript: string;
    isInterruption?: boolean;
    isPartialTranscript?: boolean; // Add this for incomplete speech
    /** Agent global prompt + name; shapes AI reprompts to match persona */
    agentConversationContext?: string;
    /** rigid: strict per-node intent scope and edge verification. flex: flow-wide intents, looser branching. */
    conversationFlowMode?: ConversationFlowMode;
    /** Optional call/session fields passed into flow tool handlers (slots still come from state). */
    toolExecutionContext?: Partial<FlowToolExecutionContext>;
    /** Multilingual: original user wording + languages (working text is userTranscript). */
    userUtteranceContext?: {
      originalText: string;
      detectedLanguage?: string;
      replyLanguage?: string;
    };
    /** voice (default) or whatsapp — affects default goodbyes and phrasing. */
    channel?: ConversationChannel;
  }): Promise<{
    nextNode: string;
    endCall?: boolean;
    responseMode?: 'template' | 'prompt';
    responseText?: string | null;
    responsePrompt?: string | null;
    /** When chaining tool → next node, speak this first (e.g. "One moment…"); history already includes it. */
    prefaceResponseText?: string;
    newState: {
      currentNode: string;
      slots: FlowSlots;
      history: FlowHistoryItem[];
      turnContext?: TurnContext; // Add this
    };
    handledAs?: 'intent' | 'slot' | 'reprompt' | 'wait_for_completion' | 'tool';
    shouldWaitForMoreInput?: boolean; // Add this
  }> {
    const {
      flow,
      state,
      userTranscript,
      isInterruption,
      isPartialTranscript,
      agentConversationContext,
      conversationFlowMode: conversationFlowModeParam,
      userUtteranceContext,
      channel = 'voice',
    } = params;
    const conversationFlowMode = normalizeConversationFlowMode(conversationFlowModeParam);
    const conversationLang = metadataToCanonicalIso6391(
      params.toolExecutionContext?.language ??
        userUtteranceContext?.replyLanguage ??
        userUtteranceContext?.detectedLanguage ??
        'en',
    );
    const utteranceFlowHint = userUtteranceContext
      ? formatUtteranceContextForFlowPrompt({
          originalText: userUtteranceContext.originalText,
          workingText: userTranscript,
          detectedLanguageIso6391: userUtteranceContext.detectedLanguage ?? 'en',
          replyLanguageIso6391: userUtteranceContext.replyLanguage ?? 'en',
          explicitLanguageRequestIso6391: null,
        })
      : '';
    const channelGoodbye = defaultFlowGoodbye(channel);
    const node = getNode(flow, state.currentNode);
    const turnContext: TurnContext = state.turnContext ?? {
      isReprompt: false,
      repromptCount: 0,
      lastNodeId: state.currentNode,
      expectingInput: false,
      silenceTimeoutMs: 900,
    };

    if (isPartialTranscript) {
      return {
        nextNode: state.currentNode,
        newState: {
          ...state,
          turnContext: {
            ...turnContext,
            expectingInput: true,
          },
        },
        shouldWaitForMoreInput: true,
        handledAs: 'wait_for_completion',
      };
    }

    if (!node) throw new BadRequestException(`Invalid node: ${state.currentNode}`);

    const normalizedInput = normalizeSttTranscript(userTranscript);
    const historyUserText = userUtteranceContext?.originalText?.trim() ?? normalizedInput;

    const slots = { ...state.slots };
    let history: FlowHistoryItem[] = [
      ...state.history,
      { role: 'user', text: historyUserText, at: nowIso() },
    ];

    // If interruption, truncate history
    if (isInterruption) {
      const lastAgentIndex = history.findLastIndex(h => h.role === 'agent');
      if (lastAgentIndex !== -1) {
        history = history.slice(0, lastAgentIndex + 1);
      }
    }

    this.logger.debug(`🔄 Processing node "${state.currentNode}" with input: "${normalizedInput}"`);

    // Tool nodes branch on tool JSON only — never treat user text as an LLM edge condition.
    if (isNewFlowFormat(flow)) {
      const rawToolNode = flow.nodes.find(
        (n): n is ToolNode =>
          n.type === 'tool' && (n.id === state.currentNode || n.name === state.currentNode),
      );
      if (rawToolNode?.tool.name) {
        const normalizedTool = getNode(flow, state.currentNode);
        return this.advanceFromToolNode({
          flow,
          toolNodeId: state.currentNode,
          normalizedNode: normalizedTool,
          slots,
          history,
          turnContext,
          conversationFlowMode,
          toolExecutionContext: params.toolExecutionContext,
          userTranscript,
        });
      }
    }

    // STEP 1: ALWAYS check for intent matches first (highest priority for flow transitions)
    let matchedIntent: string | null = null;
    const intentScopeForMatch =
      conversationFlowMode === 'flex' ? undefined : getListen(node)?.intent_scope;
    const intentMatchResult = matchIntentSimple(
      getIntents(flow),
      normalizedInput,
      intentScopeForMatch,
    );

    if (intentMatchResult) {
      matchedIntent = intentMatchResult.intent;
      this.logger.log(
        `🎯 Intent matched: "${matchedIntent}" (confidence: ${intentMatchResult.confidence})`,
      );
    }

    const transitions = getTransitions(node);
    // STEP 2: Check if this node has an intent-based transition for the matched intent
    let intentTransitionTarget: string | null = null;
    if (matchedIntent && transitions) {
      const intentTransition = transitions.find(
        (t): t is { on_intent: string; to: string } =>
          'on_intent' in t && t.on_intent === matchedIntent,
      );
      if (intentTransition?.to) {
        intentTransitionTarget = intentTransition.to;
        this.logger.log(
          `➡️ Found intent transition: "${state.currentNode}" -> "${intentTransitionTarget}" via "${matchedIntent}"`,
        );
      }
    }

    let globalIntentTarget: string | null = null;
    if (matchedIntent && !intentTransitionTarget && isNewFlowFormat(flow)) {
      globalIntentTarget = resolveGlobalIntentDestination(
        flow,
        state.currentNode,
        matchedIntent,
        slots,
        normalizedInput,
      );
      if (globalIntentTarget) {
        this.logger.log(
          `➡️ Global intent "${matchedIntent}" -> "${globalIntentTarget}" from "${state.currentNode}"`,
        );
      }
    }

    // STEP 3: Handle slot filling if there's a capture_slot
    let extractedValue: string | null = null;
    let shouldReprompt = false;
    let basketDoneJump: string | null = null;
    const listen = getListen(node);
    const sayTemplate = getSayTemplate(node);

    const basketDoneDest = getBasketDoneDestination(flow, state.currentNode);
    if (
      basketDoneDest &&
      hasOrderItemsInSlots(slots) &&
      (isDoneOrderingPhrase(normalizedInput) || matchedIntent === 'order_done')
    ) {
      basketDoneJump = basketDoneDest;
      this.logger.log(
        `🛒 Basket has items — treating "${normalizedInput}" as done ordering, jumping to "${basketDoneDest}"`,
      );
    }

    if (listen?.capture_slot && !basketDoneJump) {
      const slotName = listen.capture_slot;

      // Check if this looks like a confirmation slot
      const expectsConfirmationSlot =
        slotName.toLowerCase().includes('confirm') ||
        (sayTemplate?.toLowerCase().includes('confirm') ?? false) ||
        /\b(is that|does that|will that|correct|right)\b/i.test(sayTemplate ?? '');

      if (expectsConfirmationSlot && matchedIntent) {
        // Map yes/no intents to slot values
        const yesIntents = ['yes', 'affirm', 'confirm', 'agree', 'accept'];
        const noIntents = ['no', 'deny', 'reject', 'disagree', 'decline'];

        if (yesIntents.includes(matchedIntent)) {
          extractedValue = 'yes';
          slots[slotName] = extractedValue;
          this.logger.log(`✅ Captured confirmation: "yes" in slot "${slotName}"`);
        } else if (noIntents.includes(matchedIntent)) {
          extractedValue = 'no';
          slots[slotName] = extractedValue;
          this.logger.log(`✅ Captured confirmation: "no" in slot "${slotName}"`);
        }
        // If other intent matched, don't capture - let it transition via intent
      } else {
        const agentAsked = this.getRenderedSayContext(node, slots);
        const lastAgentMessage = history.filter(h => h.role === 'agent').pop()?.text;
        let value = await this.extractSlotValue(
          slotName,
          normalizedInput,
          agentAsked,
          node,
          flow,
          lastAgentMessage
            ? {
                lastAgentMessage,
                conversationFlowMode,
                utteranceHint: utteranceFlowHint || undefined,
              }
            : {
                conversationFlowMode,
                utteranceHint: utteranceFlowHint || undefined,
              },
        );

        if (!value && slotName === 'product') {
          for (let i = history.length - 1; i >= 0; i--) {
            const turn = history[i];
            if (turn.role !== 'user') continue;
            const fromHistory = findProductMentionInFlow(flow, turn.text);
            if (fromHistory) {
              value = fromHistory;
              this.logger.log(
                `📎 Product backfilled from prior user turn: "${turn.text}" → "${fromHistory}"`,
              );
              break;
            }
          }
        }

        if (value) {
          const slotDef = getFlowSlotDefinition(flow, slotName);
          extractedValue = normalizeSlotValue(slotDef, value);
          slots[slotName] = extractedValue;
          this.logger.log(`📦 Slot captured "${slotName}" = "${extractedValue}"`);
        } else if (!matchedIntent) {
          const slotDefForInterpret = getFlowSlotDefinition(flow, slotName);
          if (!isStructuredMenuSlot(slotDefForInterpret)) {
            value = await this.tryInterpretUserResponse(
              node,
              slotName,
              normalizedInput,
              slots,
              flow,
              agentAsked,
            );
            if (value) {
              extractedValue = normalizeSlotValue(slotDefForInterpret, value);
              slots[slotName] = extractedValue;
              this.logger.log(
                `📦 Interpreted "${slotName}" from user response: "${extractedValue}"`,
              );
            }
          }
          if (extractedValue === null) {
            shouldReprompt = true;
          }
        }
      }
    }

    // STEP 3b: LLM-based edge selection for new flow format when no intents and no slot match
    let llmEdgeDestination: string | null = null;
    const edgesForNode = getEdgesForNode(flow, state.currentNode);
    if (
      isNewFlowFormat(flow) &&
      edgesForNode &&
      edgesForNode.length > 0 &&
      !intentTransitionTarget &&
      !globalIntentTarget &&
      extractedValue === null &&
      !basketDoneJump
    ) {
      llmEdgeDestination = await this.selectEdgeByLLM(
        flow,
        state.currentNode,
        normalizedInput,
        node,
        slots,
        history.slice(-6),
        conversationFlowMode,
        utteranceFlowHint || undefined,
      );
      this.logger.debug(
        `LLM edge selection result: ${String(llmEdgeDestination)}, for input: "${normalizedInput}", capture slot: ${listen?.capture_slot ?? 'n/a'}, intents: ${matchedIntent ?? 'n/a'}`,
      );

      // LLM picked an edge but slot empty — try fast capture before strict verification (e.g. "greek")
      if (llmEdgeDestination && listen?.capture_slot) {
        const slotName = listen.capture_slot;
        const quick = extractSlotWithContext(
          slotName,
          normalizedInput,
          getFlowSlotDefinition(flow, slotName),
        );
        if (quick) {
          const slotDef = getFlowSlotDefinition(flow, slotName);
          extractedValue = normalizeSlotValue(slotDef, quick);
          slots[slotName] = extractedValue;
          this.logger.log(
            `📦 Backfilled slot "${slotName}" from LLM edge turn: "${extractedValue}"`,
          );
          llmEdgeDestination = null;
          shouldReprompt = false;
        }
      }

      if (llmEdgeDestination) {
        const picked = edgesForNode.find(e => e.destination_node_id === llmEdgeDestination);
        if (picked) {
          const slotDef = listen?.capture_slot
            ? getFlowSlotDefinition(flow, listen.capture_slot)
            : undefined;
          if (isStructuredMenuSlot(slotDef)) {
            // Menu step — trust LLM edge; slot capture uses aliases
          } else {
            const agentCtx = this.getRenderedSayContext(node, slots);
            const fullySatisfies = await this.userReplyFullySatisfiesEdgeCondition(
              agentCtx,
              normalizedInput,
              picked.condition,
              flow,
              listen?.capture_slot,
              conversationFlowMode,
            );
            if (!fullySatisfies) {
              this.logger.log(
                `⏸️ LLM edge to "${llmEdgeDestination}" rejected: user reply does not fully satisfy condition "${picked.condition}"`,
              );
              llmEdgeDestination = null;
            }
          }
        }
      }

      if (!llmEdgeDestination && extractedValue === null) {
        shouldReprompt = true;
      }
    }

    // STEP 4: Determine next node with CORRECT priority
    let nextNodeId: string;

    if (basketDoneJump) {
      nextNodeId = basketDoneJump;
      this.logger.log(`✅ Using basket-done jump to "${nextNodeId}"`);
    }
    // Priority 1: Intent-based transition (if matched and has transition)
    else if (intentTransitionTarget) {
      nextNodeId = intentTransitionTarget;
      this.logger.log(`✅ Using intent transition to "${nextNodeId}"`);
    } else if (globalIntentTarget) {
      nextNodeId = globalIntentTarget;
      this.logger.log(`✅ Using global intent transition to "${nextNodeId}"`);
    }
    // Priority 2: Slot-based transition (if we captured a value and have next)
    else if (extractedValue !== null && listen?.next) {
      nextNodeId = resolveNextNodeBySlotValue(
        flow,
        state.currentNode,
        String(extractedValue),
        listen.next,
      );
      this.logger.log(`✅ Using slot transition to "${nextNodeId}"`);
    }
    // Priority 2b: LLM-selected edge (new flow format: condition satisfied)
    else if (llmEdgeDestination) {
      nextNodeId = llmEdgeDestination;
      this.logger.log(`✅ Using LLM edge transition to "${nextNodeId}"`);
    }
    // Priority 3: Reprompt if needed (condition not satisfied or slot not captured)
    else if (shouldReprompt) {
      nextNodeId = state.currentNode;
      this.logger.log(`🔄 Reprompting on node "${nextNodeId}" (rephrase and ask again)`);
    }
    // Priority 4: Fallback transition
    else if (listen?.fallback) {
      nextNodeId = listen.fallback;
      this.logger.log(`⚠️ Using fallback to "${nextNodeId}"`);
    }
    // Priority 5: Default transition (first transition without on_intent)
    else if (transitions?.length) {
      const defaultTrans = transitions.find((t): t is { to: string } => !('on_intent' in t));
      nextNodeId = defaultTrans?.to ?? state.currentNode;
      this.logger.log(`✅ Using default transition to "${nextNodeId}"`);
    }
    // Last resort: stay on current node
    else {
      nextNodeId = state.currentNode;
      this.logger.warn(`⚠️ No transition found, staying on "${nextNodeId}"`);
    }

    // Handle reprompting (skip speaking for garbage/noise so we don't loop "I didn't catch that")
    if (nextNodeId === state.currentNode && shouldReprompt) {
      const slotName = listen?.capture_slot ?? '';
      const lastUserMessage = history.filter(h => h.role === 'user').pop();
      const lastUserText = lastUserMessage !== undefined ? lastUserMessage.text.trim() : '';

      if (this.isGarbageInput(lastUserText)) {
        this.logger.log(
          `🗑️ Skipping reprompt for garbage input, waiting for real input: "${lastUserText.substring(0, 30)}"`,
        );
        return {
          nextNode: state.currentNode,
          endCall: false,
          newState: {
            currentNode: state.currentNode,
            slots,
            history,
            turnContext: { ...turnContext, expectingInput: true },
          },
          shouldWaitForMoreInput: true,
          handledAs: 'wait_for_completion',
        };
      }

      if (this.isShortGreetingOnly(lastUserText)) {
        this.logger.log(
          `👋 Short greeting only ("${lastUserText}") — waiting for real answer, no rephrase`,
        );
        return {
          nextNode: state.currentNode,
          endCall: false,
          newState: {
            currentNode: state.currentNode,
            slots,
            history,
            turnContext: { ...turnContext, expectingInput: true },
          },
          shouldWaitForMoreInput: true,
          handledAs: 'wait_for_completion',
        };
      }

      const repromptCount = history.filter(
        h =>
          h.role === 'agent' &&
          (h.text.includes("didn't catch") ||
            h.text.includes("didn't understand") ||
            h.text.includes('Let me rephrase') ||
            h.text.includes('I meant ') ||
            h.text.includes('keep us on track') ||
            h.text.includes('I still need') ||
            h.text.includes('To continue') ||
            h.text.includes('Could you say') ||
            h.text.includes("when you're ready") ||
            h.text.includes("Whenever you're ready") ||
            h.text.includes('when you have a moment') ||
            h.text.includes('Just when you') ||
            h.text.includes('Say that again') ||
            h.text.includes('one more time') ||
            h.text.includes('So, ') ||
            h.text.includes('Could you tell me') ||
            h.text.includes('I need that again')),
      ).length;

      // After several reprompts, advance to fallback node so flow doesn't get stuck.
      // Never advance to an end node as fallback — user must explicitly proceed so we say summary then goodbye properly.
      if (repromptCount > 5 && listen?.fallback) {
        const fallbackNodeId = listen.fallback;
        const fallbackNode = getNode(flow, fallbackNodeId);
        if (fallbackNode && isEndNode(fallbackNode)) {
          this.logger.log(
            `⏸️ Skipping fallback to end node "${fallbackNodeId}" — will reprompt until user proceeds (e.g. "ok", "thanks")`,
          );
        } else if (fallbackNode) {
          this.logger.log(
            `➡️ Advancing to fallback node "${fallbackNodeId}" after ${String(repromptCount)} reprompts`,
          );
          const fallbackTemplate = getSayTemplate(fallbackNode);
          const fallbackPrompt = getSayPrompt(fallbackNode);
          const hasTemplate = !!fallbackTemplate;
          const hasPrompt = !!fallbackPrompt;
          const textToSay = hasTemplate ? renderTemplate(fallbackTemplate, { ...slots }) : null;
          const promptText = hasPrompt ? renderTemplate(fallbackPrompt, { ...slots }) : null;
          const agentResponseText = textToSay ?? (hasPrompt ? null : 'Let me move us along.');
          const newHistory: FlowHistoryItem[] =
            agentResponseText !== null
              ? [...history, { role: 'agent', text: agentResponseText, at: nowIso() }]
              : [...history];
          return {
            nextNode: fallbackNodeId,
            endCall: isEndNode(fallbackNode),
            responseMode: hasTemplate ? 'template' : 'prompt',
            responseText: textToSay,
            responsePrompt: promptText ?? undefined,
            newState: {
              currentNode: fallbackNodeId,
              slots,
              history: newHistory,
            },
            handledAs: 'intent',
          };
        }
      }

      let retryPrompt = await this.getAIRephraseForReprompt(
        node,
        slots,
        repromptCount,
        lastUserText,
        {
          slotName: slotName !== '' ? slotName : undefined,
          recentTurns: history.slice(-6),
          agentConversationContext,
          conversationFlowMode,
          language: conversationLang,
        },
      );
      retryPrompt ??= slotName
        ? this.getRephrasedPrompt(node, slotName, slots, repromptCount)
        : this.getRephrasedPromptFromSay(node, slots, repromptCount);

      return {
        nextNode: state.currentNode,
        endCall: false,
        newState: {
          currentNode: state.currentNode,
          slots,
          history: [...history, { role: 'agent', text: retryPrompt, at: nowIso() }],
        },
        responseText: retryPrompt,
        handledAs: 'reprompt',
      };
    }

    // Validate next node exists; if missing (e.g. extract-variable node not in flow), stay on current and wait for more input
    let nextNode = getNode(flow, nextNodeId);
    if (!nextNode) {
      this.logger.warn(
        `⚠️ Next node "${nextNodeId}" not found — staying on current node, waiting for user`,
      );
      nextNodeId = state.currentNode;
      nextNode = getNode(flow, nextNodeId);
      return {
        nextNode: nextNodeId,
        endCall: false,
        newState: {
          currentNode: nextNodeId,
          slots,
          history,
          turnContext: { ...turnContext, expectingInput: true },
        },
        shouldWaitForMoreInput: true,
        handledAs: 'wait_for_completion',
      };
    }

    const nextTemplate = getSayTemplate(nextNode);
    const nextPrompt = getSayPrompt(nextNode);
    const hasTemplate = !!nextTemplate;
    const hasPrompt = !!nextPrompt;
    const responseMode = hasTemplate ? 'template' : hasPrompt ? 'prompt' : 'template';

    // Fill any missing template variables from the user's message (e.g. appointment_booking from "Ok Bilal at 1 pm")
    const filledSlots = { ...slots };
    const slotNamesInNext = this.getSlotNamesFromTemplate(nextTemplate ?? '');
    const slotNamesInPrompt = this.getSlotNamesFromTemplate(nextPrompt ?? '');
    const allSlotNames = [...new Set([...slotNamesInNext, ...slotNamesInPrompt])];
    const agentAsked = this.getRenderedSayContext(node, filledSlots);
    const lastAgentTurn = history.filter(h => h.role === 'agent').pop();
    const lastAgentMsg = lastAgentTurn?.text;
    for (const slotName of allSlotNames) {
      if (filledSlots[slotName] == null || slotValueToString(filledSlots[slotName]).trim() === '') {
        const value = await this.extractSlotValue(
          slotName,
          userTranscript,
          agentAsked,
          node,
          flow,
          lastAgentMsg !== undefined
            ? { lastAgentMessage: lastAgentMsg, conversationFlowMode }
            : { conversationFlowMode },
        );
        if (value) {
          filledSlots[slotName] = value;
          this.logger.log(`📦 Filled template slot "${slotName}" from user message: "${value}"`);
        }
      }
    }

    let textToSay: string | null = null;
    let promptText: string | null = null;

    if (responseMode === 'template') {
      textToSay = hasTemplate
        ? renderTemplate(nextTemplate, { ...filledSlots })
        : isEndNode(nextNode)
          ? channelGoodbye
          : 'Okay.';
    } else if (hasPrompt && nextPrompt) {
      promptText = renderTemplate(nextPrompt, { ...filledSlots });
    }

    const agentResponseText: string | null = textToSay ?? null;
    const newHistory: FlowHistoryItem[] =
      agentResponseText !== null
        ? [...history, { role: 'agent', text: agentResponseText, at: nowIso() }]
        : [...history];

    this.logger.log(
      `✅ Transition: "${state.currentNode}" -> "${nextNodeId}" (endCall: ${String(isEndNode(nextNode))})`,
    );

    const nextTool = (nextNode as NormalizedNode).tool;
    if (nextTool?.name) {
      return this.chainToolAfterTransition({
        flow,
        toolNodeId: nextNodeId,
        toolRef: nextTool,
        filledSlots,
        toolNodeHistory: newHistory,
        userTranscript,
        conversationFlowMode,
        toolExecutionContext: params.toolExecutionContext,
        turnContext,
      });
    }

    return {
      nextNode: nextNodeId,
      endCall: isEndNode(nextNode),
      responseMode,
      responseText: textToSay,
      responsePrompt: promptText,
      newState: {
        currentNode: nextNodeId,
        slots: filledSlots,
        history: newHistory,
      },
      handledAs: intentTransitionTarget ? 'intent' : extractedValue ? 'slot' : 'intent',
    };
  }

  private pickToolBranchDestination(
    edges: { condition: string; destination_node_id: string }[],
    parsed: Record<string, unknown>,
  ): string {
    if (edges.length === 0) {
      throw new BadRequestException('Tool node has no outgoing edges');
    }
    const ok = parsed.ok === true;
    const failEdge = edges.find(e => /\b(fail|failure|error)\b/i.test(e.condition));
    const successEdge = edges.find(e => {
      const c = e.condition;
      if (/\b(fail|failure|error)\b/i.test(c)) return false;
      return /\bsuccessful\b|\bsuccess\b|\bcompleted\b|\bcomplete\b|\bok\b|\bpass\b|\bsucceed\b/i.test(
        c,
      );
    });
    if (ok) {
      if (successEdge) return successEdge.destination_node_id;
      if (failEdge) {
        const other = edges.find(e => e.destination_node_id !== failEdge.destination_node_id);
        if (other) return other.destination_node_id;
      }
      return edges[0].destination_node_id;
    }
    const suggested = parsed.suggested_node_id;
    if (typeof suggested === 'string' && suggested.trim() !== '') {
      const nodeId = suggested.trim();
      const wired = edges.find(e => e.destination_node_id === nodeId);
      if (wired) return wired.destination_node_id;
      // Tool may suggest a retry node (e.g. ask-sauce-2) not listed on the fail edge
      return nodeId;
    }
    if (failEdge) return failEdge.destination_node_id;
    if (successEdge) {
      const other = edges.find(e => e.destination_node_id !== successEdge.destination_node_id);
      if (other) return other.destination_node_id;
    }
    return edges[edges.length - 1].destination_node_id;
  }

  private mergeToolJsonIntoSlots(
    slots: FlowSlots,
    parsed: Record<string, unknown>,
    toolName: string,
    raw: string,
  ): FlowSlots {
    const next: FlowSlots = {
      ...slots,
      tool_last_output: raw,
      tool_last_name: toolName,
    };
    const safeToolName = this.normalizeToolSlotKey(toolName) || 'tool';
    for (const [k, v] of Object.entries(parsed)) {
      const key = this.normalizeToolSlotKey(k);
      if (!key) continue;

      // Write generic keys (e.g. "temperature_c") and namespaced keys
      // (e.g. "get_weather_temperature_c") for collision-safe templates.
      this.writeToolValueToSlots(next, key, v);
      this.writeToolValueToSlots(next, `${safeToolName}_${key}`, v);
    }
    return next;
  }

  private normalizeToolSlotKey(input: string): string {
    return input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private writeToolValueToSlots(
    slots: FlowSlots,
    baseKey: string,
    value: unknown,
    depth = 0,
  ): void {
    if (!baseKey || depth > 3) return;

    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      slots[baseKey] = value;
      return;
    }

    if (value instanceof Date) {
      slots[baseKey] = value.toISOString();
      return;
    }

    if (Array.isArray(value)) {
      slots[baseKey] = JSON.stringify(value);
      value.slice(0, 5).forEach((item, i) => {
        this.writeToolValueToSlots(slots, `${baseKey}_${String(i)}`, item, depth + 1);
      });
      return;
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      slots[baseKey] = JSON.stringify(record);
      for (const [childKeyRaw, childValue] of Object.entries(record)) {
        const childKey = this.normalizeToolSlotKey(childKeyRaw);
        if (!childKey) continue;
        this.writeToolValueToSlots(slots, `${baseKey}_${childKey}`, childValue, depth + 1);
      }
      return;
    }

    slots[baseKey] = String(value);
  }

  /** Whether the flow should wait for user speech while on this node (not used for tool nodes). */
  private nodeExpectsUserInput(
    flow: ConversationFlowJSON,
    node: NormalizedNode | FlowNodeLegacy | null,
    nodeId: string,
  ): boolean {
    if (!node || isEndNode(node)) return false;
    if (getListen(node)?.capture_slot) return true;
    if (isNewFlowFormat(flow)) {
      const edges = getEdgesForNode(flow, nodeId);
      if (edges && edges.length > 0) return true;
    }
    const tr = getTransitions(node);
    return !!(tr && tr.length > 0);
  }

  private buildToolArgsFromPayload(
    payload: Record<string, unknown> | undefined,
    slots: FlowSlots,
  ): Record<string, unknown> {
    if (!payload || typeof payload !== 'object') return {};
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string') {
        args[k] = renderTemplate(v, slots).trim();
      } else {
        args[k] = v;
      }
    }
    return args;
  }

  private async executeFlowToolReference(
    flow: ConversationFlowJSON,
    toolRef: { name: string; payload?: Record<string, unknown> },
    slots: FlowSlots,
    toolExecutionContext?: Partial<FlowToolExecutionContext>,
  ): Promise<{ raw: string; parsed: Record<string, unknown> }> {
    const defs = getFlowToolDefinitions(flow);
    const def = defs.find(d => d.name === toolRef.name);
    const args = this.buildToolArgsFromPayload(toolRef.payload, slots);
    const ctx: FlowToolExecutionContext = {
      slots,
      openaiClient: this.openaiClient,
      ...toolExecutionContext,
    };
    const raw = await this.flowToolExecutor.execute(toolRef.name, def?.executorKey, args, ctx);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = { ok: false, error: 'invalid_tool_json', raw };
    }
    return { raw, parsed };
  }

  private async buildDestinationAgentTurn(options: {
    flow: ConversationFlowJSON;
    destNodeId: string;
    mergedSlots: FlowSlots;
    userTranscript: string;
    contextNode: NormalizedNode | FlowNodeLegacy | null;
    conversationFlowMode: ConversationFlowMode;
    history: FlowHistoryItem[];
  }): Promise<{
    destNode: NormalizedNode | FlowNodeLegacy | null;
    filledSlots: FlowSlots;
    responseMode: 'template' | 'prompt';
    responseText: string | null;
    responsePrompt: string | null;
    agentResponseText: string | null;
  }> {
    const destNode = getNode(options.flow, options.destNodeId);
    const nextTemplate = getSayTemplate(destNode);
    const nextPrompt = getSayPrompt(destNode);
    const hasTemplate = !!nextTemplate;
    const hasPrompt = !!nextPrompt;
    const responseMode = hasTemplate ? 'template' : hasPrompt ? 'prompt' : 'template';

    const filledSlots = { ...options.mergedSlots };
    const slotNamesInNext = this.getSlotNamesFromTemplate(nextTemplate ?? '');
    const slotNamesInPrompt = this.getSlotNamesFromTemplate(nextPrompt ?? '');
    const allSlotNames = [...new Set([...slotNamesInNext, ...slotNamesInPrompt])];
    const agentAsked = this.getRenderedSayContext(options.contextNode, filledSlots);
    const lastAgentTurn = options.history.filter(h => h.role === 'agent').pop();
    const lastAgentMsg = lastAgentTurn?.text;
    for (const slotName of allSlotNames) {
      if (filledSlots[slotName] == null || slotValueToString(filledSlots[slotName]).trim() === '') {
        const value = await this.extractSlotValue(
          slotName,
          options.userTranscript,
          agentAsked,
          options.contextNode,
          options.flow,
          lastAgentMsg !== undefined
            ? { lastAgentMessage: lastAgentMsg, conversationFlowMode: options.conversationFlowMode }
            : { conversationFlowMode: options.conversationFlowMode },
        );
        if (value) {
          filledSlots[slotName] = value;
          this.logger.log(`📦 Filled template slot "${slotName}" from user message: "${value}"`);
        }
      }
    }

    let textToSay: string | null = null;
    let promptText: string | null = null;

    if (responseMode === 'template') {
      textToSay = hasTemplate
        ? renderTemplate(nextTemplate, { ...filledSlots })
        : isEndNode(destNode)
          ? defaultFlowGoodbye('voice')
          : 'Okay.';
    } else if (hasPrompt && nextPrompt) {
      promptText = renderTemplate(nextPrompt, { ...filledSlots });
    }

    const agentResponseText: string | null = textToSay ?? null;
    return {
      destNode,
      filledSlots,
      responseMode,
      responseText: textToSay,
      responsePrompt: promptText,
      agentResponseText,
    };
  }

  private async advanceFromToolNode(params: {
    flow: ConversationFlowJSON;
    toolNodeId: string;
    normalizedNode: NormalizedNode | FlowNodeLegacy | null;
    slots: FlowSlots;
    history: FlowHistoryItem[];
    turnContext: TurnContext;
    conversationFlowMode: ConversationFlowMode;
    toolExecutionContext?: Partial<FlowToolExecutionContext>;
    userTranscript: string;
  }): Promise<{
    nextNode: string;
    endCall?: boolean;
    responseMode?: 'template' | 'prompt';
    responseText?: string | null;
    responsePrompt?: string | null;
    newState: {
      currentNode: string;
      slots: FlowSlots;
      history: FlowHistoryItem[];
      turnContext?: TurnContext;
    };
    handledAs?: 'tool';
  }> {
    const toolRef = (params.normalizedNode as NormalizedNode | null)?.tool;
    if (!toolRef?.name) {
      throw new BadRequestException(`Tool node "${params.toolNodeId}" has no tool reference`);
    }
    const { raw, parsed } = await this.executeFlowToolReference(
      params.flow,
      toolRef,
      params.slots,
      params.toolExecutionContext,
    );
    const mergedSlots = this.mergeToolJsonIntoSlots(params.slots, parsed, toolRef.name, raw);
    const edges = getEdgesForNode(params.flow, params.toolNodeId);
    if (!edges?.length) {
      throw new BadRequestException(`Tool node "${params.toolNodeId}" has no edges`);
    }
    const destId = this.pickToolBranchDestination(edges, parsed);
    const presentation = await this.buildDestinationAgentTurn({
      flow: params.flow,
      destNodeId: destId,
      mergedSlots,
      userTranscript: params.userTranscript,
      contextNode: params.normalizedNode,
      conversationFlowMode: params.conversationFlowMode,
      history: params.history,
    });

    const finalHistory: FlowHistoryItem[] =
      presentation.agentResponseText != null
        ? [...params.history, { role: 'agent', text: presentation.agentResponseText, at: nowIso() }]
        : [...params.history];

    this.logger.log(
      `✅ Tool node "${params.toolNodeId}" -> "${destId}" (branch from tool result, endCall: ${String(
        isEndNode(presentation.destNode),
      )})`,
    );

    return {
      nextNode: destId,
      endCall: isEndNode(presentation.destNode),
      responseMode: presentation.responseMode,
      responseText: presentation.responseText,
      responsePrompt: presentation.responsePrompt,
      newState: {
        currentNode: destId,
        slots: presentation.filledSlots,
        history: finalHistory,
        turnContext: {
          ...params.turnContext,
          expectingInput: this.nodeExpectsUserInput(params.flow, presentation.destNode, destId),
        },
      },
      handledAs: 'tool',
    };
  }

  private async chainToolAfterTransition(params: {
    flow: ConversationFlowJSON;
    toolNodeId: string;
    toolRef: { name: string; payload?: Record<string, unknown> };
    filledSlots: FlowSlots;
    toolNodeHistory: FlowHistoryItem[];
    userTranscript: string;
    conversationFlowMode: ConversationFlowMode;
    toolExecutionContext?: Partial<FlowToolExecutionContext>;
    turnContext: TurnContext;
  }): Promise<{
    nextNode: string;
    endCall?: boolean;
    responseMode?: 'template' | 'prompt';
    responseText?: string | null;
    responsePrompt?: string | null;
    prefaceResponseText?: string;
    newState: {
      currentNode: string;
      slots: FlowSlots;
      history: FlowHistoryItem[];
      turnContext?: TurnContext;
    };
    handledAs?: 'tool';
  }> {
    const toolNode = getNode(params.flow, params.toolNodeId);
    const { raw, parsed } = await this.executeFlowToolReference(
      params.flow,
      params.toolRef,
      params.filledSlots,
      params.toolExecutionContext,
    );
    const mergedSlots = this.mergeToolJsonIntoSlots(
      params.filledSlots,
      parsed,
      params.toolRef.name,
      raw,
    );
    const edges = getEdgesForNode(params.flow, params.toolNodeId);
    if (!edges?.length) {
      throw new BadRequestException(`Tool node "${params.toolNodeId}" has no edges`);
    }
    const destId = this.pickToolBranchDestination(edges, parsed);

    const presentation = await this.buildDestinationAgentTurn({
      flow: params.flow,
      destNodeId: destId,
      mergedSlots,
      userTranscript: params.userTranscript,
      contextNode: toolNode,
      conversationFlowMode: params.conversationFlowMode,
      history: params.toolNodeHistory,
    });

    const finalHistory: FlowHistoryItem[] =
      presentation.agentResponseText != null
        ? [
            ...params.toolNodeHistory,
            { role: 'agent', text: presentation.agentResponseText, at: nowIso() },
          ]
        : [...params.toolNodeHistory];

    this.logger.log(
      `✅ Tool chain "${params.toolNodeId}" -> "${destId}" (endCall: ${String(
        isEndNode(presentation.destNode),
      )})`,
    );

    const agentTurns = params.toolNodeHistory.filter(h => h.role === 'agent');
    const prefaceResponseText =
      agentTurns.length > 0 ? agentTurns[agentTurns.length - 1]?.text : undefined;

    return {
      nextNode: destId,
      endCall: isEndNode(presentation.destNode),
      responseMode: presentation.responseMode,
      responseText: presentation.responseText,
      responsePrompt: presentation.responsePrompt,
      prefaceResponseText:
        prefaceResponseText && prefaceResponseText !== presentation.agentResponseText
          ? prefaceResponseText
          : undefined,
      newState: {
        currentNode: destId,
        slots: presentation.filledSlots,
        history: finalHistory,
        turnContext: {
          ...params.turnContext,
          expectingInput: this.nodeExpectsUserInput(params.flow, presentation.destNode, destId),
        },
      },
      handledAs: 'tool',
    };
  }

  /** Extract {{slot_name}} placeholders from a template or prompt string */
  private getSlotNamesFromTemplate(template: string): string[] {
    if (!template || typeof template !== 'string') return [];
    const matches = template.match(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map(m => m.replace(/\{\{\s*|\s*\}\}/g, '').trim()))];
  }

  private getSlotDescription(slotName: string): string {
    let description = slotName.replace(/_/g, ' ');
    if (description.includes(' name') && !description.includes("'s name")) {
      description = description.replace(/\b(\w+)\s+name\b/gi, "$1's name");
    }
    return description;
  }

  /** Rendered say (template or prompt) with slots filled — gives AI full context for extraction and reprompts */
  private getRenderedSayContext(
    node: NormalizedNode | FlowNodeLegacy | null,
    slots: FlowSlots,
  ): string {
    const raw = getSayText(node);
    if (!raw) return this.getSlotDescription(getListen(node)?.capture_slot ?? '');
    return renderTemplate(raw, slots)
      .replace(/\{\{\s*\w+\s*\}\}/g, '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /**
   * When user said something else (no direct extraction): try to interpret as answer or handle gracefully.
   * Returns NOT_FOUND when the user gave only part of what was asked (e.g. only doctor, not time) so we can rephrase with a follow-up.
   */
  private async tryInterpretUserResponse(
    _node: NormalizedNode | FlowNodeLegacy | null,
    _slotName: string,
    userTranscript: string,
    _slots: FlowSlots,
    _flow: ConversationFlowJSON,
    agentAsked: string,
  ): Promise<string | null> {
    const prompt = `Phone call. The agent asked: "${agentAsked}"

The user said: "${userTranscript}"

Does the user's response contain a COMPLETE answer to what the agent asked?
- If the agent asked for BOTH things (e.g. doctor name AND time slot) and the user gave only ONE (e.g. only "Dr. Bilal" or only "2 pm"), return NOT_FOUND so the agent can ask for the missing part.
- If the user gave a complete value (possibly rephrased or with extra words), return ONLY that value (max 15 words).
- If the user is off-topic, asking a question, or did not answer, return NOT_FOUND.

Value or NOT_FOUND:`;

    try {
      const result = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content: `You interpret phone conversation responses. Return the value only when it is a COMPLETE answer. If the user gave only part of what was asked (e.g. only doctor name when both doctor and time were needed), return NOT_FOUND.`,
          },
          { role: 'user', content: prompt },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.2, maxTokens: 50 },
      );
      const clean = result.trim();
      if (!clean || clean === 'NOT_FOUND' || clean.length < 2) return null;
      return clean;
    } catch {
      return null;
    }
  }

  /**
   * Build rephrase from the node's say (template or prompt). Prefer short human question (e.g. "Which doctor and time?") over long template.
   */
  private getRephrasedPrompt(
    node: NormalizedNode | FlowNodeLegacy | null,
    slotName: string,
    slots: FlowSlots,
    repromptCount: number,
  ): string {
    const slotDesc = this.getSlotDescription(slotName);
    const rawTemplate = getSayText(node);
    let questionForUser = rawTemplate
      ? renderTemplate(rawTemplate, slots)
          .replace(/\{\{\s*\w+\s*\}\}/g, '')
          .trim()
          .replace(/\s+/g, ' ')
      : '';

    const isMetaInstruction = /ask the user|user for|tell me|get the|collect/i.test(
      questionForUser,
    );
    if (isMetaInstruction || questionForUser.length < 5) {
      questionForUser = '';
    }
    if (questionForUser.length > 55) {
      const lastSentence = questionForUser.split(/[.!?]/).filter(Boolean).pop()?.trim();
      questionForUser =
        lastSentence !== undefined && lastSentence.length <= 55
          ? lastSentence
          : this.getShortQuestionFromSlot(slotName);
    }

    const fromSlotQuestion = this.getShortQuestionFromSlot(slotName).replace(/\?+$/, '').trim();
    const whatWeNeed =
      questionForUser.length > 0
        ? questionForUser.replace(/\?+$/, '').trim()
        : fromSlotQuestion !== ''
          ? fromSlotQuestion
          : slotDesc;

    // When user gave a wrong/unrelated answer (e.g. "thirty two" when we asked for name), rephrase clearly: "Let me rephrase — whose name?"
    // First time = explicit rephrase; later = softer variants. Don't use filler on first time entering the node (that's the main question, not a rephrase).
    const variants: string[] = [
      `Let me rephrase — ${whatWeNeed}?`,
      `I meant ${whatWeNeed}. Could you tell me that?`,
      `Sorry, I need that again — ${whatWeNeed}?`,
      `One more time — ${whatWeNeed}?`,
      `I still need that — ${whatWeNeed}?`,
      `When you're ready — ${whatWeNeed}.`,
      `I'm having trouble hearing. ${whatWeNeed}?`,
    ];

    if (repromptCount >= variants.length) {
      return `I'm having trouble catching that. Let me connect you to someone who can help.`;
    }
    return variants[repromptCount];
  }

  /**
   * Rephrase when node has no capture_slot (e.g. condition-based edges). Uses what the agent asked (say text) to rephrase.
   */
  private getRephrasedPromptFromSay(
    node: NormalizedNode | FlowNodeLegacy | null,
    slots: FlowSlots,
    repromptCount: number,
  ): string {
    const rawTemplate = getSayText(node);
    let questionForUser = rawTemplate
      ? renderTemplate(rawTemplate, slots)
          .replace(/\{\{\s*\w+\s*\}\}/g, '')
          .trim()
          .replace(/\s+/g, ' ')
      : '';

    const isMetaInstruction = /ask the user|user for|tell me|get the|collect|say\s+"/i.test(
      questionForUser,
    );
    if (isMetaInstruction && questionForUser.length > 5) {
      questionForUser = questionForUser
        .replace(/^say\s+["']?/i, '')
        .replace(/["']\s*$/, '')
        .trim();
    }
    if (questionForUser.length > 55) {
      const lastSentence = questionForUser.split(/[.!?]/).filter(Boolean).pop()?.trim();
      questionForUser =
        lastSentence !== undefined && lastSentence.length <= 55
          ? lastSentence
          : `${questionForUser.slice(0, 52)}...`;
      if (questionForUser === '') {
        questionForUser = 'that';
      }
    }
    const whatWeNeed =
      questionForUser.length > 0 ? questionForUser.replace(/\?+$/, '').trim() : 'your response';

    // Wrong/unrelated answer: rephrase clearly
    const variants: string[] = [
      `Let me rephrase — ${whatWeNeed}?`,
      `I meant ${whatWeNeed}. Could you tell me that?`,
      `One more time — ${whatWeNeed}?`,
      `When you're ready — ${whatWeNeed}.`,
    ];
    if (repromptCount >= variants.length) {
      return `I'm having trouble catching that. ${whatWeNeed}?`;
    }
    return variants[repromptCount];
  }

  /**
   * Use AI to rephrase when the user didn't answer, gave a partial answer, or went off-topic.
   * If the user gave only part of what was asked (e.g. only doctor name, not time), acknowledge it and ask for the missing part with options.
   */
  private async getAIRephraseForReprompt(
    node: NormalizedNode | FlowNodeLegacy | null,
    slots: FlowSlots,
    repromptCount: number,
    lastUserText: string,
    options?: {
      slotName?: string;
      recentTurns?: FlowHistoryItem[];
      language?: string;
      agentConversationContext?: string;
      conversationFlowMode?: ConversationFlowMode;
    },
  ): Promise<string | null> {
    const fullContext = node ? this.getRenderedSayContext(node, slots) : '';
    const contextForPrompt =
      fullContext.length > 1000 ? `${fullContext.slice(0, 997)}...` : fullContext;
    const conversationContext =
      options?.recentTurns && options.recentTurns.length > 0
        ? `Recent conversation:\n${options.recentTurns.map(h => `${h.role === 'agent' ? 'Agent' : 'User'}: ${h.text}`).join('\n')}\n\n`
        : '';
    const softness =
      repromptCount >= 1
        ? ' Use a softer, patient tone (e.g. "Whenever you\'re ready...", "Just when you have a moment...").'
        : '';

    const personaBlock = options?.agentConversationContext?.trim()
      ? `The agent must follow these global instructions (name, tone, persona) in your rephrase:\n${options.agentConversationContext.trim()}\n\n`
      : '';

    const flexRepromptHint =
      options?.conversationFlowMode === 'flex'
        ? '\n5. FLEX MODE: The rephrase may sound slightly more conversational while still asking for what the flow needs.\n'
        : '';

    const langInstruction = languageInstructionForRepromptLlm(
      options?.language ?? 'en',
    );

    const prompt = `${personaBlock}${langInstruction}You are a helpful phone agent. The user's response was unclear, only partial, off-topic, or didn't answer what was asked. Your job is to ask again in a clear, helpful way.

${conversationContext}What the agent asked or needs from the user (full context; may include options like doctor names and times):
"${contextForPrompt}"

User's last response: "${lastUserText}"

RULES:
1. If the user gave only PART of what was asked (e.g. only a doctor's name but no time, or only "yes" without specifying which option): ACKNOWLEDGE what they said, then ask specifically for the MISSING part. When the context lists options (e.g. "Dr Bilal (Saturday 1pm–3pm), Dr Robeel (Sunday 5pm–7pm)"), include those options in your follow-up (e.g. "You said Dr. Bilal — which time slot works for you: Saturday 1pm–3pm, Sunday 5pm–7pm, or Saturday 10pm–12am?").
2. If the user gave nothing useful or went off-topic: rephrase the full question clearly; you may shorten it but keep the meaning and any important options.
3. Be polite and specific. Do NOT use stock phrases like "Let me rephrase" or "I meant" unless they fit naturally.${softness}
4. Output ONE natural sentence only. No quotes or explanation. End with a question if asking for input.${flexRepromptHint}`;

    try {
      const result = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content: `${langInstruction}You output a single natural follow-up or rephrase for a phone call. Acknowledge partial answers and ask for the missing part with options when relevant. One sentence only. No quotes or preamble.`,
          },
          { role: 'user', content: prompt },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.4, maxTokens: 120 },
      );
      const rephrase = result.trim();
      if (rephrase.length > 5 && rephrase.length < 350) {
        const normalized =
          rephrase.endsWith('?') || rephrase.endsWith('.') ? rephrase : `${rephrase}?`;
        // First reprompt: skip verifier (saves 1–2+ LLM round-trips). Later reprompts still get quality checks.
        if (repromptCount === 0) {
          return normalized.length < 350 ? normalized : `${normalized.slice(0, 347)}?`;
        }
        const verified = await this.verificationService.verifyAndCorrect({
          generatedResponse: normalized,
          userInput: lastUserText,
          nodeContext: fullContext,
          slotName: options?.slotName,
          language: metadataToCanonicalIso6391(options?.language ?? 'en'),
          generationType: 'rephrase',
          recentTurns: options?.recentTurns,
        } as AgentResponseVerificationInput);
        const out = verified.endsWith('?') || verified.endsWith('.') ? verified : `${verified}?`;
        return out.length < 350 ? out : `${out.slice(0, 347)}?`;
      }
    } catch (err) {
      this.logger.warn('AI rephrase for reprompt failed, using fallback:', err);
    }
    const templateFallback = options?.slotName
      ? this.getRephrasedPrompt(node, options.slotName, slots, 0)
      : this.getRephrasedPromptFromSay(node, slots, 0);
    return templateFallback;
  }

  /**
   * Short human question from slot name (no "appointment" jargon); used when template is empty or too long.
   */
  private getShortQuestionFromSlot(slotName: string): string {
    const lower = slotName.toLowerCase();
    if (lower.includes('appointment') && (lower.includes('book') || lower.includes('booking')))
      return 'Which doctor and time would you like?';
    if (lower.includes('confirm')) return 'Would you like to confirm?';
    if (lower.includes('doctor') || lower.includes('time'))
      return 'Which doctor and time would work for you?';
    const desc = this.getSlotDescription(slotName);
    return `${desc.replace(/^./, c => c.toUpperCase())}?`;
  }

  /**
   * Use AI to rephrase when the user didn't respond yet. Keeps the question clear and includes options when relevant (e.g. doctor times).
   */
  async getNoResponseRephrase(
    node: NormalizedNode | FlowNodeLegacy | null,
    slots: FlowSlots,
    options?: { language?: string },
  ): Promise<string> {
    const raw = getSayText(node);
    const slotName = getListen(node)?.capture_slot ?? '';
    const slotDesc = slotName ? this.getSlotDescription(slotName) : '';
    const whatAgentAsked = raw
      ? renderTemplate(raw, slots)
          .replace(/\{\{\s*\w+\s*\}\}/g, '')
          .trim()
          .replace(/\s+/g, ' ')
      : slotDesc !== ''
        ? slotDesc
        : 'the information we need';
    const contextForPrompt =
      whatAgentAsked.length > 400 ? `${whatAgentAsked.slice(0, 397)}...` : whatAgentAsked;

    const langInstruction = languageInstructionForRepromptLlm(options?.language ?? 'en');

    const prompt = `${langInstruction}You are helping rephrase a phone agent's question because the user didn't respond yet.

What the agent asked (full context; may include options like doctor names and times): "${contextForPrompt}"

Generate ONE short, natural sentence to ask again. Use a gentle filler (e.g. "Whenever you're ready — ...", "So, ...") then the same question. If the context lists specific options (e.g. doctors and times), you may briefly mention them so the user knows what to pick. Keep it conversational (under 25 words). Output ONLY the rephrase, no quotes or explanation.`;

    try {
      const result = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content: `${langInstruction}You output a single short, natural rephrase for a phone call. One sentence only. No quotes or preamble.`,
          },
          { role: 'user', content: prompt },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.5, maxTokens: 80 },
      );
      const rephrase = result.trim();
      if (rephrase.length > 5 && rephrase.length < 250) {
        const normalized =
          rephrase.endsWith('?') || rephrase.endsWith('.') ? rephrase : `${rephrase}?`;
        const verified = await this.verificationService.verifyAndCorrect({
          generatedResponse: normalized,
          userInput: '[No response yet]',
          nodeContext: contextForPrompt,
          slotName: slotName !== '' ? slotName : undefined,
          language: metadataToCanonicalIso6391(options?.language ?? 'en'),
          generationType: 'no_response_rephrase',
        } as AgentResponseVerificationInput);
        const out = verified.endsWith('?') || verified.endsWith('.') ? verified : `${verified}?`;
        return out.length < 250 ? out : `${out.slice(0, 247)}?`;
      }
    } catch (err) {
      this.logger.warn('AI rephrase failed, using fallback:', err);
    }

    const fallback =
      whatAgentAsked.length > 50
        ? `Whenever you're ready — ${whatAgentAsked.slice(0, 47).trim()}...?`
        : `Whenever you're ready — ${whatAgentAsked !== '' ? whatAgentAsked : 'could you tell me?'}?`;
    return fallback;
  }

  /**
   * Runs flow.next() and auto-chains through tool nodes (no extra user message required).
   */
  async advanceFlowTurn(
    params: Parameters<FlowRuntimeService['next']>[0],
  ): Promise<Awaited<ReturnType<FlowRuntimeService['next']>>> {
    let result = await this.next(params);
    let hops = 0;
    while (hops < 12 && isToolNodeAt(params.flow, result.newState.currentNode)) {
      hops++;
      result = await this.next({
        ...params,
        state: result.newState,
        userTranscript: '',
      });
    }
    return result;
  }

  /** Turn flow-runtime output into user-facing text (templates, LLM prompts, tools, goodbyes). */
  async resolveTurnReply(params: {
    flow: ConversationFlowJSON;
    result: Awaited<ReturnType<FlowRuntimeService['next']>>;
    channel?: ConversationChannel;
    agentConversationContext?: string;
    conversationFlowMode?: ConversationFlowMode;
    toolExecutionContext?: Partial<FlowToolExecutionContext>;
  }): Promise<string> {
    const channel = params.channel ?? 'voice';
    const { flow, result } = params;
    const mode = normalizeConversationFlowMode(params.conversationFlowMode);

    if (result.endCall) {
      return this.resolveEndTurnReply(flow, result, channel, params);
    }

    const parts: string[] = [];
    const preface = result.prefaceResponseText?.trim();
    if (preface) {
      parts.push(adaptFlowTextForChannel(preface, channel));
    }

    if (result.responseText?.trim()) {
      parts.push(adaptFlowTextForChannel(result.responseText.trim(), channel));
    } else if (result.responsePrompt?.trim()) {
      const generated = await this.generateChannelPromptReply({
        flow,
        promptTemplate: result.responsePrompt,
        slots: result.newState.slots,
        history: result.newState.history,
        channel,
        agentConversationContext: params.agentConversationContext,
        conversationFlowMode: mode,
        toolExecutionContext: params.toolExecutionContext,
      });
      if (generated.trim()) {
        parts.push(generated);
      }
    }

    if (parts.length === 0) {
      return defaultFlowFallbackReply(channel);
    }
    return parts.join('\n\n');
  }

  private async resolveEndTurnReply(
    flow: ConversationFlowJSON,
    result: Awaited<ReturnType<FlowRuntimeService['next']>>,
    channel: ConversationChannel,
    params: {
      agentConversationContext?: string;
      conversationFlowMode?: ConversationFlowMode;
      toolExecutionContext?: Partial<FlowToolExecutionContext>;
    },
  ): Promise<string> {
    const endNode =
      getNode(flow, result.newState.currentNode) ||
      getNode(flow, 'end_node') ||
      getNode(flow, 'end-node');

    let text =
      (result.responseText ?? result.responsePrompt ?? '').trim() || defaultFlowGoodbye(channel);

    if (endNode && isEndNode(endNode)) {
      const sayPrompt = getSayPrompt(endNode);
      const sayTemplate = getSayTemplate(endNode);
      if (sayTemplate) {
        text = renderTemplate(sayTemplate, result.newState.slots);
      } else if (sayPrompt) {
        text = await this.generateChannelPromptReply({
          flow,
          promptTemplate: renderTemplate(sayPrompt, result.newState.slots),
          slots: result.newState.slots,
          history: result.newState.history,
          channel,
          agentConversationContext: params.agentConversationContext,
          conversationFlowMode: params.conversationFlowMode,
          toolExecutionContext: params.toolExecutionContext,
        });
      }
    }

    return adaptFlowTextForChannel(text, channel) || defaultFlowGoodbye(channel);
  }

  private async generateChannelPromptReply(params: {
    flow: ConversationFlowJSON;
    promptTemplate: string;
    slots: FlowSlots;
    history: FlowHistoryItem[];
    channel: ConversationChannel;
    agentConversationContext?: string;
    conversationFlowMode?: ConversationFlowMode;
    toolExecutionContext?: Partial<FlowToolExecutionContext>;
  }): Promise<string> {
    const prompt = renderTemplate(params.promptTemplate, params.slots);
    const mode = normalizeConversationFlowMode(params.conversationFlowMode);
    const agentBlock = params.agentConversationContext?.trim();
    const personaPrefix = agentBlock ? `${agentBlock}\n\n` : '';
    const rigidRules =
      'AGENTIC RULES: Lead the conversation one step at a time. Keep responses to 1-2 short sentences.';
    const flexRules =
      'FLEX MODE: Use conversation history; speak naturally while fulfilling this step. Keep responses to 1-2 short sentences.';
    const agenticRules = mode === 'flex' ? flexRules : rigidRules;
    const flowTools = getFlowToolDefinitions(params.flow);
    const toolsHint =
      flowTools.length > 0
        ? '\n\nWhen helpful, use the provided functions to fetch data before answering. Summarize results naturally — never dump raw JSON.'
        : '';

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      {
        role: 'system',
        content: `${personaPrefix}${channelAgentRules(params.channel)} ${prompt}\n\n${agenticRules}${toolsHint}`,
      },
      ...params.history.map(h => ({
        role: h.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: h.text,
      })),
    ];

    const toolContext: FlowToolExecutionContext = {
      slots: params.slots,
      openaiClient: this.openaiClient,
      ...params.toolExecutionContext,
      channel: params.channel,
    };

    if (flowTools.length > 0) {
      const raw = await this.flowToolExecutor.runToolAugmentedChat(
        this.openaiClient,
        messages,
        flowTools,
        toolContext,
        {
          model: OpenAIModel.GPT_4O_MINI,
          temperature: 0.7,
          maxTokens: params.channel === 'whatsapp' ? 400 : 200,
        },
      );
      return adaptFlowTextForChannel(raw.trim(), params.channel);
    }

    const raw = await this.openaiClient.chatCompletion(messages, OpenAIModel.GPT_4O_MINI, {
      temperature: 0.7,
      maxTokens: params.channel === 'whatsapp' ? 400 : 200,
    });
    return adaptFlowTextForChannel(raw.trim(), params.channel);
  }
}
