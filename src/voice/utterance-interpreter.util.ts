import { OpenAIClient } from '../clients/openai/openai.client';
import { OpenAIModel } from '../common/enums';
import {
  languageDisplayName,
  metadataToCanonicalIso6391,
  resolveConversationReplyLanguage,
} from './call-language';

export interface UtteranceInterpretation {
  /** Raw STT transcript (unchanged). */
  originalText: string;
  /** Text used for flow edges, slots, and intents (faithful meaning; menu terms in Latin when needed). */
  workingText: string;
  detectedLanguageIso6391: string;
  /** Language the agent should use for the next spoken reply. */
  replyLanguageIso6391: string;
  /** ISO 639-1 code the user explicitly asked to switch/continue in this turn, or null. */
  explicitLanguageRequestIso6391: string | null;
}

export interface InterpretUserUtteranceParams {
  transcript: string;
  sttDetectedLanguage?: string;
  agentLanguage: string;
  agentContext?: string;
  menuHint?: string;
}

/**
 * Uses the LLM to preserve what the caller said while producing text the flow can match
 * (e.g. English menu labels) and picking the language for the agent's reply.
 */
export async function interpretUserUtterance(
  openai: OpenAIClient,
  params: InterpretUserUtteranceParams,
): Promise<UtteranceInterpretation> {
  const original = params.transcript.trim();
  const agentLang = metadataToCanonicalIso6391(params.agentLanguage);
  const sttLang = params.sttDetectedLanguage
    ? metadataToCanonicalIso6391(params.sttDetectedLanguage)
    : undefined;

  if (!original) {
    return {
      originalText: '',
      workingText: '',
      detectedLanguageIso6391: agentLang,
      replyLanguageIso6391: agentLang,
      explicitLanguageRequestIso6391: null,
    };
  }

  // No LLM-skip fast path here: even when STT/script already agree with the current agent
  // language, the transcript could still be an explicit language-switch request phrased in that
  // same language ("Actually, can we switch to Spanish?" said while the agent is speaking
  // English) — skipping the LLM would silently miss it, so every turn goes through interpretation.

  const agentLangName = languageDisplayName(agentLang);
  const menuBlock = params.menuHint?.trim()
    ? `\nMENU / SLOT HINT (keep these product names in Latin script when translating):\n${params.menuHint}\n`
    : '';
  const contextBlock = params.agentContext?.trim()
    ? `\nAGENT LAST SAID:\n"${params.agentContext.slice(0, 800)}"\n`
    : '';
  const sttHint = sttLang
    ? `\nSTT detected language code: ${sttLang} (${languageDisplayName(sttLang)}). Treat this as a weak hint only. STT may mislabel Urdu/Roman Urdu/Pakistani-accented speech as Hindi.\n`
    : '';

  const prompt = `You interpret phone call user speech for an automated agent.

CALL AGENT LANGUAGE (default for replies): ${agentLang} (${agentLangName})
${sttHint}${contextBlock}${menuBlock}
USER TRANSCRIPT (as heard by speech-to-text):
"${original}"

Important interpretation rules:
- HIGHEST PRIORITY RULE: if every word in the transcript is ordinary English (not Roman Urdu/Hindi — e.g. no words like "hai", "ka", "mausam", "kya", "shehar"), the user IS speaking English right now, full stop. This overrides CALL AGENT LANGUAGE and any STT hint — set detected_language="en" and reply_language="en", and leave working_text in English exactly as transcribed (do not translate it into Urdu/Hindi/anything else). A caller can switch to English mid-call even if the call defaulted to another language; a single all-English sentence is "clearly switched to English."
- The STT transcript may contain incorrect words caused by accent, Urdu/Roman Urdu pronunciation, or Hindi/Urdu confusion.
- Do NOT blindly trust the STT detected language. It may detect Urdu or Roman Urdu as Hindi.
- If CALL AGENT LANGUAGE is Urdu and the user sounds like they are speaking Urdu/Roman Urdu (actual Urdu/Hindi words, not just an accent), set detected_language to "ur", not "hi", unless the user clearly switched to Hindi.
- Preserve the caller's intended meaning, not the exact mistaken STT words.
- If a word sounds like a menu item, product name, slot value, or known option from the menu/context, normalize it to that item.
- Keep menu/product names in Latin script exactly as used by the agent/menu, for example: Smol Wrap, Wehshi, Chipotle.
- Do NOT replace Pakistani/Urdu wording with Hindi-style wording.
- Do NOT summarize, shorten, or drop details.
- EXPLICIT LANGUAGE REQUEST RULE: if the user is explicitly asking to speak, switch to, or continue in a specific language — e.g. "can we speak English?", "kunnen we Engels spreken?", "parlez-vous français?", "können wir auf Deutsch weitermachen?", "¿hablas español?", "could we continue in X?" — set explicit_language_request to that language's ISO 639-1 code. This applies to ANY language the user names, not just English, and is independent of which language the request itself is phrased in. If there is no such explicit ask, set explicit_language_request to null.

Return a single JSON object with exactly these keys:
- "detected_language": ISO 639-1 code for the language the user is speaking, e.g. en, ur, ar, no
- "reply_language": ISO 639-1 code the agent should use for the next reply. Usually same as detected_language. If CALL AGENT LANGUAGE is ur, prefer ur unless the user is speaking English (see HIGHEST PRIORITY RULE above).
- "working_text": Faithful wording of what the user meant, suitable for order/slot matching. If the agent/menu uses English product names, translate surrounding words into English if needed, but KEEP menu item names in Latin script.
- "explicit_language_request": ISO 639-1 code per the EXPLICIT LANGUAGE REQUEST RULE above, or null.

JSON only, no markdown:`;

  try {
    const raw = await openai.chatCompletion(
      [
        {
          role: 'system',
          content:
            'You output only valid JSON. You are robust to STT mistakes, accents, Roman Urdu, Urdu/Hindi confusion, and phonetic menu-item matching. Preserve user intent exactly; translate only when needed for menu/order matching.',
        },
        { role: 'user', content: prompt },
      ],
      OpenAIModel.GPT_4O_MINI,
      { temperature: 0, maxTokens: 200 },
    );

    const parsed = parseInterpretationJson(raw);
    if (parsed) {
      const detected = metadataToCanonicalIso6391(parsed.detected_language ?? sttLang ?? agentLang);
      const llmReply = metadataToCanonicalIso6391(parsed.reply_language ?? detected);
      const explicitRequest = parsed.explicit_language_request?.trim()
        ? metadataToCanonicalIso6391(parsed.explicit_language_request)
        : undefined;
      const reply = resolveConversationReplyLanguage({
        agentLanguage: agentLang,
        explicitRequest,
        llmDetected: detected,
        llmReply,
        sttDetected: sttLang,
        transcript: original,
      });
      const working = (parsed.working_text ?? original).trim() || original;
      return {
        originalText: original,
        workingText: working,
        detectedLanguageIso6391: detected,
        replyLanguageIso6391: reply,
        explicitLanguageRequestIso6391: explicitRequest ?? null,
      };
    }
  } catch {
    // fall through
  }

  const detected = sttLang ?? agentLang;
  const reply = resolveConversationReplyLanguage({
    agentLanguage: agentLang,
    llmDetected: detected,
    sttDetected: sttLang,
    transcript: original,
  });
  return {
    originalText: original,
    workingText: original,
    detectedLanguageIso6391: detected,
    replyLanguageIso6391: reply,
    explicitLanguageRequestIso6391: null,
  };
}

function parseInterpretationJson(raw: string): {
  detected_language?: string;
  reply_language?: string;
  working_text?: string;
  explicit_language_request?: string | null;
} | null {
  const trimmed = raw.trim();
  const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as {
      detected_language?: string;
      reply_language?: string;
      working_text?: string;
      explicit_language_request?: string | null;
    };
  } catch {
    return null;
  }
}

/** One-line hint for flow LLM edge/slot prompts. */
export function formatUtteranceContextForFlowPrompt(ctx: UtteranceInterpretation): string {
  if (ctx.originalText === ctx.workingText) return '';
  const lang = languageDisplayName(ctx.detectedLanguageIso6391);
  return `User spoke in ${lang}. Original: "${ctx.originalText}". For matching use: "${ctx.workingText}".`;
}

export interface LocalizeFlowAgentSpeechParams {
  text: string;
  targetLanguageIso6391: string;
  /** Last line the agent spoke (keeps phrasing consistent across nodes). */
  recentAgentLine?: string;
}

/**
 * Flow JSON lines are authored in English; localize for TTS/history while keeping menu terms in Latin script.
 */
export async function localizeFlowAgentSpeech(
  openai: OpenAIClient,
  params: LocalizeFlowAgentSpeechParams,
): Promise<string> {
  const source = params.text.trim();
  const target = metadataToCanonicalIso6391(params.targetLanguageIso6391);
  if (!source || target === 'en') return source;

  const targetName = languageDisplayName(target);
  const continuity = params.recentAgentLine?.trim()
    ? `\nPREVIOUS AGENT LINE (keep the same language and tone):\n"${params.recentAgentLine.slice(0, 400)}"\n`
    : '';

  const prompt = `Translate this phone agent line into ${targetName} (${target}) for text-to-speech.

SOURCE (English flow script):
"${source}"
${continuity}
Rules:
- Output ONLY the translated line, no quotes or explanation.
- Keep brand and menu item names in Latin script unchanged (e.g. Smol Wrap, Wehshi, Chipotle, Coke).
- Keep numbers, prices, and slot values as in the source.
- Natural spoken ${targetName} for a phone call — same meaning, same question type (yes/no vs open).${
    target === 'ur' ? '\n- Write Urdu in Arabic (Nastaliq) script, not Devanagari.' : ''
  }

Translated line:`;

  try {
    const result = await openai.chatCompletion(
      [
        {
          role: 'system',
          content: `You translate call-center agent lines into ${targetName}. Output only the translated sentence.`,
        },
        { role: 'user', content: prompt },
      ],
      OpenAIModel.GPT_4O_MINI,
      { temperature: 0, maxTokens: 200 },
    );
    const out = result.trim().replace(/^["']|["']$/g, '');
    if (out.length >= 3) return out;
  } catch {
    // fall through
  }
  return source;
}

export interface LocalizeFlowAgentSpeechChunkParams {
  /** The full English reply this chunk belongs to (context only — only chunkText is translated). */
  fullText: string;
  /** The single sentence/chunk to translate. */
  chunkText: string;
  targetLanguageIso6391: string;
  /** Already-translated chunks of this same reply spoken so far (keeps phrasing/tense consistent). */
  precedingTranslatedChunks?: string[];
}

/**
 * Translate one sentence of a longer flow reply while keeping it consistent with the sentences
 * already spoken (and the full source), so a multi-sentence reply can be translated and spoken
 * sentence-by-sentence instead of waiting for the whole reply to translate before any audio plays.
 */
export async function localizeFlowAgentSpeechChunk(
  openai: OpenAIClient,
  params: LocalizeFlowAgentSpeechChunkParams,
): Promise<string> {
  const chunk = params.chunkText.trim();
  const target = metadataToCanonicalIso6391(params.targetLanguageIso6391);
  if (!chunk || target === 'en') return chunk;

  const targetName = languageDisplayName(target);
  const preceding = params.precedingTranslatedChunks?.filter(c => c.trim()).join(' ');
  const continuity = preceding
    ? `\nALREADY SPOKEN (this same reply, keep tense/phrasing/tone consistent with this):\n"${preceding.slice(-400)}"\n`
    : '';

  const prompt = `Translate ONE sentence of a phone agent's reply into ${targetName} (${target}) for text-to-speech.

FULL ENGLISH REPLY (context only — translate just the sentence below, not the whole thing):
"${params.fullText.trim().slice(0, 800)}"
${continuity}
SENTENCE TO TRANSLATE:
"${chunk}"

Rules:
- Output ONLY the translated sentence, no quotes or explanation.
- Keep brand and menu item names in Latin script unchanged (e.g. Smol Wrap, Wehshi, Chipotle, Coke).
- Keep numbers, prices, and slot values as in the source.
- Natural spoken ${targetName} for a phone call, consistent with the sentences already spoken.${
    target === 'ur' ? '\n- Write Urdu in Arabic (Nastaliq) script, not Devanagari.' : ''
  }

Translated sentence:`;

  try {
    const result = await openai.chatCompletion(
      [
        {
          role: 'system',
          content: `You translate call-center agent lines into ${targetName}, one sentence at a time, staying consistent with prior sentences. Output only the translated sentence.`,
        },
        { role: 'user', content: prompt },
      ],
      OpenAIModel.GPT_4O_MINI,
      { temperature: 0, maxTokens: 200 },
    );
    const out = result.trim().replace(/^["']|["']$/g, '');
    if (out.length >= 2) return out;
  } catch {
    // fall through
  }
  return chunk;
}
