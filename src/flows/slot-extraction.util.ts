import type { ConversationFlowJSON, FlowSlotDefinition } from './types/flows.types';
import {
  getBasketDoneDestination,
  getFlowSlotDefinition,
  getFlowSlotDefinitions,
  getNode,
  getNodeEdges,
} from './flow-accessors';

const DEFAULT_DECLINE_PHRASES = ['no', 'none', 'nothing', 'skip', 'without', 'nah', "don't", 'dont'];

/** Whether the utterance is a decline for an optional slot (from flow JSON config). */
export function isOptionalSlotDecline(def: FlowSlotDefinition | undefined, text: string): boolean {
  if (!def?.optional) return false;
  const t = text.toLowerCase().trim();
  const phrases = def.decline_phrases?.length ? def.decline_phrases : DEFAULT_DECLINE_PHRASES;
  if (!phrases.some(p => t.includes(p.toLowerCase()))) return false;
  const exclude = def.decline_exclude_if_contains ?? [];
  if (exclude.some(ex => t.includes(ex.toLowerCase()))) return false;
  return true;
}

/** Normalize captured value using optional-decline rules from slot definition. */
export function normalizeSlotValue(
  def: FlowSlotDefinition | undefined,
  value: string,
): string {
  if (!def) return value;
  if (def.optional && isOptionalSlotDecline(def, value)) {
    return def.decline_value ?? 'none';
  }
  return value;
}

function matchAliases(
  text: string,
  aliases: Record<string, string>,
  multi?: boolean,
  multiJoin?: string,
): string | null {
  const t = text.toLowerCase().trim();
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);

  if (multi) {
    const picked: string[] = [];
    for (const key of keys) {
      if (t.includes(key.toLowerCase())) {
        const canonical = aliases[key];
        if (!picked.includes(canonical)) picked.push(canonical);
      }
    }
    return picked.length ? picked.join(multiJoin ?? ', ') : null;
  }

  for (const key of keys) {
    if (t.includes(key.toLowerCase())) return aliases[key];
  }
  return null;
}

function matchChoices(text: string, choices: string[]): string | null {
  const t = text.toLowerCase().trim();
  const sorted = [...choices].sort((a, b) => b.length - a.length);
  for (const choice of sorted) {
    if (t.includes(choice.toLowerCase())) return choice;
  }
  return null;
}

/**
 * Fast path: extract slot value from flow `slot_definitions` (aliases, choices, optional decline).
 * Returns null when no definition or no match (caller may fall back to AI).
 */
export function fastExtractFromFlowSlotDefinition(
  def: FlowSlotDefinition | undefined,
  text: string,
): string | null {
  if (!def) return null;
  const t = text.trim();
  if (!t) return null;

  if (def.optional && isOptionalSlotDecline(def, text)) {
    return def.decline_value ?? 'none';
  }

  if (def.aliases && Object.keys(def.aliases).length > 0) {
    const fromAliases = matchAliases(text, def.aliases, def.multi, def.multi_join);
    if (fromAliases) return fromAliases;
  }

  if (def.choices?.length) {
    const fromChoices = matchChoices(text, def.choices);
    if (fromChoices) return fromChoices;
  }

  return null;
}

/** Contextual patterns: "first sauce is chipotle", "second sauce would be mushroom". */
const SLOT_CONTEXT_PATTERNS: Record<string, RegExp[]> = {
  sauce_1: [
    /\b(?:first|1st|one)\s+(?:sauce|sause)\s*(?:is|will be|would be|:)?\s*(.+)/i,
    /\b(?:sauce|sause)\s*(?:number\s*)?one\s*(?:is|:)?\s*(.+)/i,
  ],
  sauce_2: [
    /\b(?:second|2nd|two)\s+(?:sauce|sause)\s*(?:is|will be|would be|:)?\s*(.+)/i,
    /\b(?:sauce|sause)\s*(?:number\s*)?two\s*(?:is|:)?\s*(.+)/i,
  ],
  product: [/\b(?:order|want|like|get|add)\s+(?:a\s+)?(.+)/i],
};

export function extractSlotWithContext(
  slotName: string,
  text: string,
  def: FlowSlotDefinition | undefined,
): string | null {
  const normalized = normalizeSttTranscript(text);
  if (slotName === 'product' && isDoneOrderingPhrase(normalized)) return null;

  const patterns = SLOT_CONTEXT_PATTERNS[slotName];
  if (patterns) {
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        const inner = fastExtractFromFlowSlotDefinition(def, match[1].trim());
        if (inner) return inner;
      }
    }
  }
  return fastExtractFromFlowSlotDefinition(def, normalized);
}

export function fastExtractConfiguredSlot(
  flow: ConversationFlowJSON,
  slotName: string,
  text: string,
): string | null {
  const def = getFlowSlotDefinition(flow, slotName);
  return extractSlotWithContext(slotName, text, def);
}

/** Slot definition uses aliases/choices — skip slow LLM extraction and strict edge re-checks. */
export function isStructuredMenuSlot(def: FlowSlotDefinition | undefined): boolean {
  if (!def) return false;
  return Boolean(
    (def.aliases && Object.keys(def.aliases).length > 0) || (def.choices && def.choices.length > 0),
  );
}

export function hasOrderItemsInSlots(slots: Record<string, unknown>): boolean {
  const raw = slots.order_items;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

export function isDoneOrderingPhrase(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (
    /\b(that'?s all|thats all|nothing else|no more items?|i'?m done|all set|that'?s it|thats it)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(don'?t|do not)\s+want\s+(another|more|to add)\b/.test(t)) return true;
  if (/\bno\s+more\s+(items?|products?|orders?)\b/.test(t)) return true;
  if (/\b(finish|finalize|done)\s+(?:my\s+)?order\b/.test(t)) return true;
  return false;
}

export function isNegatedOrderMorePhrase(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(don'?t|do not|no)\s+want\s+(another|more|to add)\b/.test(t) ||
    /\bno\s+more\b/.test(t) ||
    /\b(that'?s|thats)\s+(all|it)\b/.test(t)
  );
}

/**
 * After capture, pick next node when edges define `when_slot_value` (first match wins).
 */
export function resolveNextNodeBySlotValue(
  flow: ConversationFlowJSON,
  nodeId: string,
  capturedValue: string,
  defaultNext: string,
): string {
  const edges = getNodeEdges(flow, nodeId);
  if (!edges.length) return defaultNext;

  const normalized = capturedValue.toLowerCase().trim();
  for (const edge of edges) {
    const matchers = edge.when_slot_value;
    if (!matchers?.length) continue;
    const hit = matchers.some(m => {
      const needle = m.toLowerCase().trim();
      return normalized === needle || normalized.includes(needle);
    });
    if (hit && edge.destination_node_id) {
      return edge.destination_node_id;
    }
  }
  return defaultNext;
}

/** True when agent/edge context allows optional decline and user declined. */
export function userDeclinedOptionalSlotInContext(
  flow: ConversationFlowJSON,
  captureSlotName: string | undefined,
  agentContext: string,
  edgeCondition: string,
  userTranscript: string,
): boolean {
  if (!captureSlotName) return false;
  const def = getFlowSlotDefinition(flow, captureSlotName);
  if (!def?.optional) return false;
  if (!isOptionalSlotDecline(def, userTranscript)) return false;

  const agentLower = agentContext.toLowerCase();
  const condLower = edgeCondition.toLowerCase();
  const optionalInPrompt =
    /\b(or say no|no thanks|none|skip|don't want|without|optional)\b/.test(agentLower) ||
    /\b(declined|none|no thanks|skip|optional)\b/.test(condLower);
  return optionalInPrompt;
}

/** Collapse letter-by-letter STT (e.g. "S-M-O-L-L" → "smoll", "W-R-A-P" → "wrap"). */
export function collapseSpelledTokens(text: string): string {
  return text.replace(/\b((?:[a-z]\s*[-.,]+\s*){2,}[a-z])\b/gi, segment => {
    const letters = segment.replace(/[^a-z]/gi, '');
    if (letters.length >= 3 && letters.length <= 14) {
      return letters.toLowerCase();
    }
    return segment;
  });
}

/** Common STT / user typos before slot or intent matching. */
export function normalizeSttTranscript(text: string): string {
  let t = text.trim().replace(/\s+/g, ' ');
  t = collapseSpelledTokens(t);
  return t
    .replace(/\bsause\b/gi, 'sauce')
    .replace(/\bmashroom\b/gi, 'mushroom')
    .replace(/\bchiptle\b/gi, 'chipotle')
    .replace(/\bchiptole\b/gi, 'chipotle')
    .replace(/\btotilla\b/gi, 'tortilla')
    .replace(/\bwourl\b/gi, 'would')
    .replace(/\baould\b/gi, 'would')
    .replace(/\bsmall\s+bird\b/gi, 'smol wrap')
    .replace(/\bsmall\s+bag\b/gi, 'smol wrap')
    .replace(/\bsmall\s+drive\b/gi, 'smol wrap')
    .replace(/\bsmall\s+cup\b/gi, 'smol wrap')
    .replace(/\bsame\s+lady\b/gi, 'yes ready')
    .replace(/\bphilly\s+burger\b/gi, 'fillet burger')
    .replace(/\bsmoll\b/gi, 'smol');
}

/** Affirmative / intent to start ordering (handles STT mishears on "yes, I'm ready"). */
export function isReadyToOrderPhrase(text: string): boolean {
  const t = normalizeSttTranscript(text).toLowerCase().trim();
  if (!t) return false;
  if (/^(yes|yeah|yep|yup|sure|ok|okay|alright|all right)\b/.test(t)) return true;
  if (/\b(ready|want to order|like to order|would like to order|place an order|i'?ll order)\b/.test(t)) {
    return true;
  }
  if (/\border\b/.test(t) && /\b(want|like|would|ready)\b/.test(t)) return true;
  return false;
}

/** Scan text for a configured product alias (used for history backfill). */
export function findProductMentionInFlow(
  flow: ConversationFlowJSON,
  text: string,
): string | null {
  const def = getFlowSlotDefinition(flow, 'product');
  return extractSlotWithContext('product', text, def);
}

/** True if utterance matches any alias/choice from flow slot_definitions (menu words are never noise). */
export function transcriptMatchesAnyFlowSlotAlias(
  flow: ConversationFlowJSON,
  text: string,
): boolean {
  const normalized = normalizeSttTranscript(text);
  const defs = getFlowSlotDefinitions(flow);
  for (const def of Object.values(defs)) {
    if (fastExtractFromFlowSlotDefinition(def, normalized)) return true;
  }
  return false;
}

/** Short menu / order phrases that must never be dropped as STT noise. */
export const MENU_SHORT_RESPONSES = new Set([
  'none',
  'no',
  'yes',
  'ok',
  'okay',
  'atomic',
  'greek',
  'garlic',
  'cheese',
  'pickles',
  'jalapenos',
  'chipotle',
  'mushroom',
  'wehshi',
  'fillet',
  'delivery',
  'pickup',
]);

export function isKnownMenuShortResponse(text: string): boolean {
  const t = normalizeSttTranscript(text).toLowerCase().trim();
  if (MENU_SHORT_RESPONSES.has(t)) return true;
  return t.length >= 3 && t.length <= 12 && /^[a-z]+$/i.test(t);
}

/** Build LLM hint listing valid values for a slot (aliases + choices). */
export function formatSlotDefForLlm(def: FlowSlotDefinition | undefined): string {
  if (!def) return '';
  const parts: string[] = [];
  if (def.choices?.length) {
    parts.push(`Allowed values: ${def.choices.join(', ')}`);
  }
  if (def.aliases && Object.keys(def.aliases).length > 0) {
    const canonical = [...new Set(Object.values(def.aliases))];
    parts.push(`Menu options (accept typos like chiptle→Chipotle): ${canonical.join(', ')}`);
  }
  if (def.optional) {
    parts.push(`Optional — user may decline with: ${(def.decline_phrases ?? ['no', 'none']).join(', ')}`);
  }
  return parts.join('. ');
}

/**
 * Global intent → node when the current node has no legacy on_intent transition (new flow format).
 */
export function resolveGlobalIntentDestination(
  flow: ConversationFlowJSON,
  currentNodeId: string,
  intent: string,
  slots: Record<string, unknown>,
  userTranscript: string,
): string | null {
  const basketDest = getBasketDoneDestination(flow, currentNodeId);
  if (
    (intent === 'order_done' || isDoneOrderingPhrase(userTranscript)) &&
    hasOrderItemsInSlots(slots)
  ) {
    if (basketDest) return basketDest;
    if (currentNodeId === 'ask-product' || currentNodeId === 'ask-another') return 'ask-drink';
  }
  // if (intent === 'no_order') {
  //   for (const id of ['end-order', 'end_order', 'end-call', 'end_call']) {
  //     if (getNode(flow, id)) return id;
  //   }
  // }
  return null;
}
