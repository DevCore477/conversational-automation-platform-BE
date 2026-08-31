import { Injectable, Logger } from '@nestjs/common';

import { OpenAIClient } from '../../clients/openai/openai.client';
import { OpenAIModel } from '../../common/enums';
import { metadataToCanonicalIso6391 } from '../../voice/call-language';

function languageDisplayName(iso6391: string): string {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    const n = dn.of(iso6391);
    if (n) return n;
  } catch {
    // ignore
  }
  return iso6391;
}

@Injectable()
export class ScriptOpeningMessageService {
  private readonly logger = new Logger(ScriptOpeningMessageService.name);
  private static readonly MAX_SCRIPT_CHARS = 12000;

  constructor(private readonly openaiClient: OpenAIClient) {}

  /**
   * Produces a contextual first spoken line from the full agent script when no explicit firstMessage is set.
   * Returns undefined on failure so the voice layer can fall back to {@link defaultScriptOpeningMessage}.
   */
  async generateFromScript(
    script: string,
    languageRaw: string | undefined,
  ): Promise<string | undefined> {
    const trimmed = script.trim();
    if (!trimmed) return undefined;

    const canon = metadataToCanonicalIso6391(languageRaw);
    const scriptBody =
      trimmed.length > ScriptOpeningMessageService.MAX_SCRIPT_CHARS
        ? `${trimmed.slice(0, ScriptOpeningMessageService.MAX_SCRIPT_CHARS)}\n\n[... script truncated for context ...]`
        : trimmed;

    const langName = languageDisplayName(canon);

    try {
      const result = await this.openaiClient.chatCompletion(
        [
          {
            role: 'system',
            content:
              'You write the first thing an AI phone agent says when the call connects to User, AI phone agent is calling the user. Output exactly one spoken message, with no title, quotes, or labels. Base the content strictly on the provided script: say who is calling or what the call is about, what will be handled, and a clear next step or question. Avoid a generic receptionist greeting unless the script is only generic reception. Be warm and concise (one to three short sentences).',
          },
          {
            role: 'user',
            content: `The agent must speak in ${langName} (ISO 639-1: ${canon}).\n\n---\nAGENT SCRIPT / INSTRUCTIONS:\n${scriptBody}`,
          },
        ],
        OpenAIModel.GPT_4O_MINI,
        { temperature: 0.45, maxTokens: 220 },
      );

      const line = result.trim();
      if (!line || line.length < 12) return undefined;
      const cleaned = line.replace(/^["'«»]+|["'«»]+$/g, '').trim();
      if (cleaned.length > 1200) {
        return `${cleaned.slice(0, 1197).trimEnd()}...`;
      }
      return cleaned;
    } catch (err) {
      this.logger.warn(
        `Script opening message generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}
