/**
 * Builds text prepended to LLM system / user prompts when a call is tied to an agent
 * with optional {@link Agent.globalPrompt} and display name.
 */
export function extractAgentDisplayNameFromGlobalPrompt(prompt: string): string | null {
  const normalized = prompt.trim();
  if (!normalized) return null;

  const patterns = [
    /\bmy name is\s+["']?([A-Za-z][A-Za-z .'-]{0,39})["']?/i,
    /\bi am\s+["']?([A-Za-z][A-Za-z .'-]{0,39})["']?/i,
    /\byou are\s+["']?([A-Za-z][A-Za-z .'-]{0,39})["']?/i,
    /\bcall yourself\s+["']?([A-Za-z][A-Za-z .'-]{0,39})["']?/i,
    /\byour name is\s+["']?([A-Za-z][A-Za-z .'-]{0,39})["']?/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) continue;
    const cleaned = candidate.replace(/[.,;:!?]+$/, '').trim();
    if (cleaned.length < 2) continue;
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length > 4) continue;
    const lowered = cleaned.toLowerCase();
    if (
      /\b(ai|assistant|bot|agent|model|voice|helpful|virtual)\b/.test(lowered) ||
      /\d/.test(cleaned)
    ) {
      continue;
    }
    return cleaned;
  }

  return null;
}

export function resolveAgentDisplayNameFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string {
  if (!metadata) return '';
  const custom =
    typeof metadata.agentGlobalPrompt === 'string' ? metadata.agentGlobalPrompt.trim() : '';
  const fromGlobalPrompt = custom ? extractAgentDisplayNameFromGlobalPrompt(custom) : null;
  if (fromGlobalPrompt) return fromGlobalPrompt;
  return typeof metadata.agentName === 'string' ? metadata.agentName.trim() : '';
}

export function buildAgentGlobalPreambleFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string {
  if (!metadata) {
    return '';
  }
  const name = resolveAgentDisplayNameFromMetadata(metadata);
  const custom =
    typeof metadata.agentGlobalPrompt === 'string' ? metadata.agentGlobalPrompt.trim() : '';
  const parts: string[] = [];
  if (name) {
    parts.push(`Agent display name: "${name}". Use this name when introducing yourself.`);
  }
  if (custom) {
    parts.push('## Global instructions (apply for the entire call)\n' + custom);
  }
  return parts.join('\n\n');
}
