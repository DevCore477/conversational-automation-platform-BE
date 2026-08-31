/**
 * Detects agent lines that mean "hand off to a human / support" so we can cold-transfer the PSTN leg.
 */
export function messageImpliesSupportHandoff(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes('connect you to someone')) return true;
  if (t.includes('connect you to support')) return true;
  if (t.includes('connect you to our support')) return true;
  if (t.includes('connect you to a human')) return true;
  if (t.includes('let me transfer you')) return true;
  if (t.includes('transfer you to')) return true;
  if (t.includes("i'm having trouble catching that")) return true;
  if (t.includes('having trouble catching that') && t.includes('connect you')) return true;
  return false;
}

/**
 * Detects the CALLER directly asking to be escalated to a human — independent of what the AI/flow
 * happens to say back. This is the highest-priority transfer trigger: it fires on the raw user
 * utterance, before any flow/script/LLM processing runs, so "representative", said cold, ends the
 * automated conversation immediately rather than waiting for the bot to notice and offer a handoff.
 * Deliberately does NOT match bare "agent" — that phrasing routes through a flow's own configured
 * agent-transfer node (a specific Agent ID), which is a distinct concept from "get me a human".
 */
export function messageImpliesUserWantsHuman(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;

  // Strong enough to fire standalone, no connecting phrase needed (e.g. a caller just saying
  // "representative" to an open prompt is the classic, unambiguous IVR escape word).
  const standalone = [
    'human agent',
    'human representative',
    'human being',
    'real person',
    'real human',
    'actual person',
    'live person',
    'live agent',
    'a human',
    'representative',
    'an operator',
    'the operator',
    'talk to a person',
    'speak to a person',
  ];
  if (standalone.some(p => t.includes(p))) return true;

  // Generic enough (customer support, someone, a person) to need a connecting verb first, or these
  // would false-positive on unrelated mentions (e.g. "I already called customer support").
  const connectors = [
    'talk to',
    'speak to',
    'speak with',
    'connect me',
    'transfer me',
    'put me through',
    'i want',
    'can i talk',
    'can i speak',
    'get me',
  ];
  const targets = ['customer support', 'customer service', 'someone', 'a person'];
  if (connectors.some(c => t.includes(c)) && targets.some(tg => t.includes(tg))) return true;

  return false;
}
