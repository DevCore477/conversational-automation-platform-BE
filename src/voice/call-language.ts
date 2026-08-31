/**
 * Call language ↔ ElevenLabs STT/TTS, Whisper, LLM prompts, and default script greetings.
 * ElevenLabs Scribe realtime uses language_code (ISO 639-1 or ISO 639-3; English is typically eng).
 */

import type { ConversationFlowJSON } from '../flows/types/flows.types';
import { getEffectiveFlow, getFlowSlotDefinitions } from '../flows/flow-accessors';

/** Default menu vocabulary for food-order voice calls (ElevenLabs keyterm limit: 50 × 20 chars). */
const DEFAULT_STT_KEYTERMS: string[] = [
  'Wehshi',
  'Fillet',
  'Smol Wrap',
  'Tortilla Wrap',
  'Smol Nugg Wrap',
  'Tortilla Nugg',
  'Atomic',
  'Chipotle',
  'Greek',
  'Garlic',
  'Mushroom',
  'Jalapenos',
  'Sweetcorns',
  'smol',
  'wrap',
  'burger',
  'Coke',
  'Sprite',
  'pickup',
  'delivery',
  'ready to order',
  'Philly',
];

/** Build ElevenLabs STT keyterms from flow slot definitions + defaults. */
export function buildElevenLabsSttKeyterms(flow?: ConversationFlowJSON): string[] {
  const terms = new Set<string>();
  // for (const t of DEFAULT_STT_KEYTERMS) {
  //   const trimmed = t.trim();
  //   if (trimmed.length > 0 && trimmed.length <= 20) terms.add(trimmed);
  // }
  if (flow) {
    const effective = getEffectiveFlow(flow);
    const defs = getFlowSlotDefinitions(effective);
    for (const def of Object.values(defs)) {
      for (const choice of def.choices ?? []) {
        const c = choice.trim();
        if (c.length > 0 && c.length <= 20) terms.add(c);
      }
      if (def.aliases) {
        for (const [alias, canonical] of Object.entries(def.aliases)) {
          const a = alias.trim();
          const can = canonical.trim();
          if (a.length > 0 && a.length <= 20) terms.add(a);
          if (can.length > 0 && can.length <= 20) terms.add(can);
        }
      }
    }
  }
  return [...terms].slice(0, 50);
}

/** User/agent metadata → ISO 639-1 primary subtag (e.g. en-US → en, eng → en, nor → no). */
export function metadataToCanonicalIso6391(raw: string | undefined): string {
  const trimmed = (raw ?? 'en').trim().toLowerCase();
  if (!trimmed) return 'en';
  const primary = trimmed.split(/[-_]/)[0];
  if (ALIASES[primary]) return ALIASES[primary];
  if (/^[a-z]{2}$/.test(primary)) return primary;
  if (/^[a-z]{3}$/.test(primary)) {
    return ISO_639_3_TO_1[primary] ?? 'en';
  }
  return 'en';
}

/** ElevenLabs realtime STT query param: English uses eng; most languages use ISO 639-1. */
export function canonicalIso6391ToElevenLabsSttCode(iso6391: string): string {
  const L = iso6391.toLowerCase();
  if (L === 'en') return 'eng';
  return L;
}

export interface ElevenLabsTtsModelPickOptions {
  /** If set (e.g. from `ELEVENLABS_TTS_MODEL_ID`), always this model. */
  explicitModelId?: string;
  /** When true, always use the multilingual TTS model (e.g. all calls with auto STT language). */
  forceMultilingualModel?: boolean;
  /** Comma-separated ISO 639-1 codes that use the multilingual model (default `ur`). */
  multilingualLanguagesCsv?: string;
  /** Model for multilingual codes (default `eleven_multilingual_v2`). */
  multilingualModelId?: string;
  /** Model for all other languages (default `eleven_turbo_v2_5`). */
  defaultModelId?: string;
}

/** Ordered TTS `model_id` fallbacks when the primary model returns 403 (plan/voice incompatibility). */
export function getElevenLabsTtsFallbackChain(
  primaryModelId: string,
  fallbackCsv = 'eleven_multilingual_v2,eleven_turbo_v2_5',
): string[] {
  const seen = new Set<string>([primaryModelId]);
  const chain: string[] = [];
  for (const raw of fallbackCsv.split(',')) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }
  return chain;
}

/**
 * Pick ElevenLabs TTS `model_id` for WebSocket stream-input.
 * `eleven_v3` is used for languages that need strong multilingual synthesis (e.g. Urdu).
 */
export function resolveElevenLabsTtsModelId(
  iso6391: string,
  options?: ElevenLabsTtsModelPickOptions,
): string {
  const explicit = options?.explicitModelId?.trim();
  if (explicit) return explicit;

  if (options?.forceMultilingualModel) {
    return options.multilingualModelId ?? 'eleven_multilingual_v2';
  }

  const csv = options?.multilingualLanguagesCsv ?? 'ur,hi,ar';
  const multilingualSet = new Set(
    csv
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const L = iso6391.toLowerCase();
  if (multilingualSet.has(L)) {
    return options?.multilingualModelId ?? 'eleven_multilingual_v2';
  }
  return options?.defaultModelId ?? 'eleven_turbo_v2_5';
}

const SCRIPT_LANGUAGE_PATTERNS: Record<string, RegExp> = {
  ar: /[\u0600-\u06FF]/,
  he: /[\u0590-\u05FF]/,
  fa: /[\u0600-\u06FF]/,
  ur: /[\u0600-\u06FF]/,
  zh: /[\u4e00-\u9fff]/,
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  th: /[\u0e00-\u0e7f]/,
  hi: /[\u0900-\u097F]/,
  bn: /[\u0980-\u09FF]/,
  ta: /[\u0b80-\u0bff]/,
  te: /[\u0c00-\u0c7f]/,
  ml: /[\u0d00-\u0d7f]/,
  kn: /[\u0c80-\u0cff]/,
  gu: /[\u0a80-\u0aff]/,
  pa: /[\u0a00-\u0a75]/,
};

/** Infer language from Unicode script in STT text (when STT/LLM mislabels Urdu as Hindi, etc.). */
export function detectScriptLanguageFromText(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  for (const [lang, re] of Object.entries(SCRIPT_LANGUAGE_PATTERNS)) {
    if (re.test(t)) return lang;
  }
  if (/^[\x00-\x7F\s\d.,!?'"()-]+$/.test(t) || /[a-zA-Z]/.test(t)) return 'en';
  return null;
}

/**
 * Same as {@link detectScriptLanguageFromText} but WITHOUT the Latin/ASCII fallback to 'en'.
 * `SCRIPT_LANGUAGE_PATTERNS` only distinguishes non-Latin scripts (Arabic, CJK, Indic, ...) —
 * Latin-alphabet languages (Dutch, German, Spanish, French, ...) can't be told apart by Unicode
 * script alone, so treating "any Latin text" as English here (as the fallback above does) is
 * only correct in an English/non-Latin-script context. Used by `resolveConversationReplyLanguage`,
 * where that fallback would otherwise silently override a correct LLM-detected nl/de/es/fr with
 * 'en' before the LLM's own detection is even consulted.
 */
export function detectNonLatinScriptLanguage(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  for (const [lang, re] of Object.entries(SCRIPT_LANGUAGE_PATTERNS)) {
    if (re.test(t)) return lang;
  }
  return null;
}

export function isMostlyLatin(text: string): boolean {
  const letters = text.replace(/\s/g, '');
  if (!letters.length) return true;
  const latin = (letters.match(/[A-Za-z]/g) ?? []).length;
  return latin / letters.length >= 0.6;
}

/**
 * Sticky reply language: honors agent metadata (e.g. Urdu) over STT/LLM mis-detections.
 */
export function resolveConversationReplyLanguage(params: {
  agentLanguage: string;
  /** Highest priority: the user explicitly asked to switch/continue in this language this turn. */
  explicitRequest?: string;
  llmDetected?: string;
  llmReply?: string;
  sttDetected?: string;
  transcript?: string;
}): string {
  const agent = metadataToCanonicalIso6391(params.agentLanguage);
  const explicitRequest = params.explicitRequest
    ? metadataToCanonicalIso6391(params.explicitRequest)
    : undefined;
  const llmDetected = params.llmDetected
    ? metadataToCanonicalIso6391(params.llmDetected)
    : undefined;
  const llmReply = params.llmReply ? metadataToCanonicalIso6391(params.llmReply) : undefined;
  const stt = params.sttDetected ? metadataToCanonicalIso6391(params.sttDetected) : undefined;
  // Non-Latin-script only: a Latin-alphabet script match would be ambiguous across every
  // European language, so it must not shadow the LLM's own detection below.
  const script = params.transcript ? detectNonLatinScriptLanguage(params.transcript) : null;
  const transcript = params.transcript ?? '';

  if (explicitRequest) return explicitRequest;

  const wantsEnglish =
    (llmDetected === 'en' || llmReply === 'en' || stt === 'en') && isMostlyLatin(transcript);

  if (agent === 'ur') {
    if (wantsEnglish) return 'en';
    return 'ur';
  }

  if (wantsEnglish) return 'en';
  if (script === 'ur' && agent !== 'hi') return 'ur';
  if (script) return script;
  if (llmReply) return llmReply;
  if (llmDetected) return llmDetected;
  if (stt) return stt;
  return agent;
}

/** @deprecated Prefer metadataToCanonicalIso6391 + canonicalIso6391ToElevenLabsSttCode in STT factory */
export function metadataToElevenLabsSttLanguageCode(metadataLanguage: string | undefined): string {
  return canonicalIso6391ToElevenLabsSttCode(metadataToCanonicalIso6391(metadataLanguage));
}

export function languageDisplayName(iso6391: string): string {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    const n = dn.of(iso6391);
    if (n) return n;
  } catch {
    // ignore
  }
  return iso6391;
}

/** Prefix for system prompts so the model replies in the agent language. */
export function languageInstructionForLlmPrompt(lang: string | undefined): string {
  const canon = metadataToCanonicalIso6391(lang);
  const name = languageDisplayName(canon);
  return `You MUST respond only in ${name}. The caller is using ${name} for this conversation — every reply must stay in ${name}. Do not switch to English or any other language unless the user clearly switches first. `;
}

/** System-line prefix for reprompt / rephrase LLM calls. */
export function languageInstructionForRepromptLlm(lang: string | undefined): string {
  return languageInstructionForLlmPrompt(lang);
}

/**
 * Whether an STT-reported language matches the call's expected language (for filtering noise).
 * When `acceptAnyLanguage` is true (multilingual STT), never drop transcripts by language.
 */
export function transcriptMatchesExpectedLanguage(
  detectedLanguage: string | undefined,
  expectedLanguage: string | undefined,
  acceptAnyLanguage = false,
): boolean {
  if (acceptAnyLanguage) return true;
  if (detectedLanguage == null || detectedLanguage === '') return true;
  const exp = metadataToCanonicalIso6391(expectedLanguage);
  const det = metadataToCanonicalIso6391(detectedLanguage);
  if (exp === 'en') return det === 'en';
  return det === exp;
}

/** Default opening line for script-based (non-flow) calls when metadata.firstMessage is not set. */
export function defaultScriptOpeningMessage(iso6391: string): string {
  const L = iso6391.toLowerCase();
  return DEFAULT_SCRIPT_OPENINGS[L] ?? DEFAULT_SCRIPT_OPENINGS.en;
}

/** Explicit outbound wording for a few languages; others use {@link DEFAULT_SCRIPT_OPENINGS}. */
const OUTBOUND_SCRIPT_OPENING_OVERRIDES: Partial<Record<string, string>> = {
  en: 'Hi — thanks for picking up. How can I help you today?',
  no: 'Hei — takk for at du svarer. Hvordan kan jeg hjelpe deg?',
};

/** When no script/flow first line is set on an outbound call, avoid phrasing that sounds inbound-only. */
export function outboundDefaultScriptOpeningMessage(iso6391: string): string {
  const L = iso6391.toLowerCase();
  const o = OUTBOUND_SCRIPT_OPENING_OVERRIDES[L];
  if (o) return o;
  return DEFAULT_SCRIPT_OPENINGS[L] ?? DEFAULT_SCRIPT_OPENINGS.en;
}

/**
 * English-only openers often stored on scripts. When agent language is non-English, these should be
 * replaced with {@link defaultScriptOpeningMessage} (same as flow start-node handling).
 */
export const SCRIPT_ENGLISH_OPENER_PATTERNS: RegExp[] = [
  /^Hello!?\s*How can I (?:assist|help) you (?:today)?[.?]?\s*\.{0,3}\s*$/i,
  /^Hello!?\s*Thanks for calling\.?\s*How can I help you today\??\s*\.{0,3}\s*$/i,
  /^Hello!?\s*How can I help you\??\s*\.{0,3}\s*$/i,
];

export interface PickScriptFirstMessageOptions {
  /** Outbound calls use {@link outboundDefaultScriptOpeningMessage} when metadata has no explicit line. */
  direction?: 'inbound' | 'outbound';
}

/**
 * Picks the first spoken line for script (non-flow) calls. If metadata carries an English opener
 * but the agent language is e.g. Arabic, returns the localized default instead of English.
 */
export function pickScriptFirstMessage(
  metadataFirstMessage: string | undefined | null,
  languageRaw: string | undefined,
  options?: PickScriptFirstMessageOptions,
): string {
  const canon = metadataToCanonicalIso6391(languageRaw);
  const fallback =
    options?.direction === 'outbound'
      ? outboundDefaultScriptOpeningMessage(canon)
      : defaultScriptOpeningMessage(canon);
  const raw = metadataFirstMessage?.trim();
  if (!raw) return fallback;
  if (canon === 'en') return raw;
  if (shouldReplaceScriptFirstMessageWithLocalizedDefault(canon, raw)) {
    return fallback;
  }
  return raw;
}

/**
 * When prepending a short agent intro ("Hi, this is Sam calling."), strip duplicate greetings from
 * the scripted first line so we do not say hello twice.
 */
export function stripLeadingOverlapForMergedAgentIntro(body: string): string {
  const before = body.trim();
  let t = before;
  // English
  t = t.replace(/^(?:hello|hi|hey)!?[,\s]+/i, '').trim();
  t = t.replace(/^thanks?\s+for\s+(?:calling|contacting\s+us|your\s+call)[.!?\s\-—]*/i, '').trim();
  t = t.replace(/^(?:good\s+(?:morning|afternoon|evening))[!,.\s]+/i, '').trim();
  // Dutch
  t = t.replace(/^(?:hallo|hoi)!?[,\s]+/i, '').trim();
  t = t
    .replace(
      /^bedankt\s+(?:voor\s+het\s+bellen|dat\s+u\s+contact\s+opneemt)[^.!?]*[.!?\s\-—]*/i,
      '',
    )
    .trim();
  t = t.replace(/^goede(?:morgen|middag|avond)[!,.\s]+/i, '').trim();
  // German
  t = t.replace(/^(?:hallo|guten\s+(?:morgen|tag|abend))!?[,\s]+/i, '').trim();
  t = t.replace(/^danke\s+für\s+(?:ihren\s+anruf|den\s+anruf)[.!?\s\-—]*/i, '').trim();
  // Spanish
  t = t.replace(/^(?:hola|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)!?[,\s]+/i, '').trim();
  t = t.replace(/^gracias\s+por\s+(?:llamar|su\s+llamada)[.!?\s\-—]*/i, '').trim();
  // French
  t = t.replace(/^(?:bonjour|bonsoir|salut)!?[,\s]+/i, '').trim();
  t = t.replace(/^merci\s+(?:d'avoir\s+appel[ée]|de\s+votre\s+appel)[.!?\s\-—]*/i, '').trim();
  if (t === '') return before;
  return t;
}

function shouldReplaceScriptFirstMessageWithLocalizedDefault(canon: string, text: string): boolean {
  const scriptRequired: Record<string, RegExp> = {
    ar: /[\u0600-\u06FF]/,
    he: /[\u0590-\u05FF]/,
    fa: /[\u0600-\u06FF]/,
    ur: /[\u0600-\u06FF]/,
    zh: /[\u4e00-\u9fff]/,
    ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
    ko: /[\uac00-\ud7af]/,
    th: /[\u0e00-\u0e7f]/,
    hi: /[\u0900-\u097F]/,
    bn: /[\u0980-\u09FF]/,
    ta: /[\u0b80-\u0bff]/,
    te: /[\u0c00-\u0c7f]/,
    ml: /[\u0d00-\u0d7f]/,
    kn: /[\u0c80-\u0cff]/,
    gu: /[\u0a80-\u0aff]/,
    pa: /[\u0a00-\u0a75]/,
    my: /[\u1000-\u109f]/,
    km: /[\u1780-\u17ff]/,
    si: /[\u0d80-\u0dff]/,
    ne: /[\u0900-\u097f]/,
    mr: /[\u0900-\u097f]/,
    ka: /[\u10a0-\u10ff]/,
    hy: /[\u0530-\u058f]/,
  };
  const scriptRules = scriptRequired as Partial<Record<string, RegExp>>;
  const req = scriptRules[canon];
  if (req !== undefined) {
    return !req.test(text);
  }

  if (SCRIPT_ENGLISH_OPENER_PATTERNS.some(p => p.test(text))) return true;
  if (/^Hi,?\s*I\s+am\b/i.test(text)) return true;
  return false;
}

const ALIASES: Record<string, string> = {
  eng: 'en',
  english: 'en',
  ara: 'ar',
  arabic: 'ar',
  nor: 'no',
  nob: 'no',
  nno: 'no',
  norwegian: 'no',
  nn: 'no',
  nb: 'no',
  deu: 'de',
  ger: 'de',
  german: 'de',
  fra: 'fr',
  fre: 'fr',
  french: 'fr',
  spa: 'es',
  esl: 'es',
  spanish: 'es',
  por: 'pt',
  brazilian: 'pt',
  ita: 'it',
  italian: 'it',
  nld: 'nl',
  dut: 'nl',
  dutch: 'nl',
  swe: 'sv',
  swedish: 'sv',
  dan: 'da',
  danish: 'da',
  fin: 'fi',
  finnish: 'fi',
  pol: 'pl',
  polish: 'pl',
  rus: 'ru',
  russian: 'ru',
  ukr: 'uk',
  ukrainian: 'uk',
  ces: 'cs',
  cze: 'cs',
  czech: 'cs',
  slk: 'sk',
  slo: 'sk',
  slovak: 'sk',
  slv: 'sl',
  slovenian: 'sl',
  hun: 'hu',
  hungarian: 'hu',
  ron: 'ro',
  rum: 'ro',
  romanian: 'ro',
  bul: 'bg',
  bulgarian: 'bg',
  hrv: 'hr',
  croatian: 'hr',
  srp: 'sr',
  serbian: 'sr',
  ell: 'el',
  gre: 'el',
  greek: 'el',
  heb: 'he',
  jpn: 'ja',
  japanese: 'ja',
  zho: 'zh',
  cmn: 'zh',
  mandarin: 'zh',
  chinese: 'zh',
  kor: 'ko',
  korean: 'ko',
  hin: 'hi',
  hindi: 'hi',
  tur: 'tr',
  turkish: 'tr',
  vie: 'vi',
  vietnamese: 'vi',
  ind: 'id',
  indonesian: 'id',
  msa: 'ms',
  malay: 'ms',
  fil: 'fil',
  filipino: 'fil',
  swa: 'sw',
  swahili: 'sw',
  ben: 'bn',
  bengali: 'bn',
  tam: 'ta',
  tamil: 'ta',
  tel: 'te',
  telugu: 'te',
  urd: 'ur',
  urdu: 'ur',
  fas: 'fa',
  pes: 'fa',
  persian: 'fa',
  cat: 'ca',
  catalan: 'ca',
  eus: 'eu',
  basque: 'eu',
  glg: 'gl',
  galician: 'gl',
  cym: 'cy',
  welsh: 'cy',
  gle: 'ga',
  irish: 'ga',
  isl: 'is',
  icelandic: 'is',
  mkd: 'mk',
  macedonian: 'mk',
  sqi: 'sq',
  albanian: 'sq',
  lav: 'lv',
  latvian: 'lv',
  lit: 'lt',
  lithuanian: 'lt',
  est: 'et',
  estonian: 'et',
  kaz: 'kk',
  kazakh: 'kk',
  uzb: 'uz',
  uzbek: 'uz',
  aze: 'az',
  azerbaijani: 'az',
  kat: 'ka',
  georgian: 'ka',
  hye: 'hy',
  armenian: 'hy',
  mya: 'my',
  burmese: 'my',
  khm: 'km',
  khmer: 'km',
  sin: 'si',
  sinhala: 'si',
  nep: 'ne',
  nepali: 'ne',
  mar: 'mr',
  marathi: 'mr',
  guj: 'gu',
  gujarati: 'gu',
  kan: 'kn',
  kannada: 'kn',
  mal: 'ml',
  malayalam: 'ml',
  pan: 'pa',
  punjabi: 'pa',
  tha: 'th',
  thai: 'th',
};

/** ISO 639-3 → ISO 639-1 for codes not covered by ALIASES primary segment */
const ISO_639_3_TO_1: Record<string, string> = {
  eng: 'en',
  ara: 'ar',
  nor: 'no',
  nob: 'no',
  nno: 'no',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  por: 'pt',
  ita: 'it',
  nld: 'nl',
  swe: 'sv',
  dan: 'da',
  fin: 'fi',
  pol: 'pl',
  rus: 'ru',
  ukr: 'uk',
  ces: 'cs',
  slk: 'sk',
  slv: 'sl',
  hun: 'hu',
  ron: 'ro',
  bul: 'bg',
  hrv: 'hr',
  srp: 'sr',
  ell: 'el',
  heb: 'he',
  jpn: 'ja',
  zho: 'zh',
  cmn: 'zh',
  yue: 'zh',
  kor: 'ko',
  hin: 'hi',
  tur: 'tr',
  vie: 'vi',
  ind: 'id',
  zsm: 'ms',
  sun: 'su',
  fil: 'fil',
  swh: 'sw',
  ben: 'bn',
  tam: 'ta',
  tel: 'te',
  urd: 'ur',
  pes: 'fa',
  cat: 'ca',
  eus: 'eu',
  glg: 'gl',
  cym: 'cy',
  gle: 'ga',
  isl: 'is',
  mkd: 'mk',
  sqi: 'sq',
  lav: 'lv',
  lit: 'lt',
  est: 'et',
  kaz: 'kk',
  uzb: 'uz',
  aze: 'az',
  kat: 'ka',
  hye: 'hy',
  mya: 'my',
  khm: 'km',
  sin: 'si',
  nep: 'ne',
  mar: 'mr',
  guj: 'gu',
  kan: 'kn',
  mal: 'ml',
  pan: 'pa',
  tha: 'th',
};

/**
 * Localized default first utterance for script calls (and flow fallbacks).
 * Extend when you add first-class agent languages.
 */
// const DEFAULT_SCRIPT_OPENINGS: Record<string, string> = {
//   en: 'Hello! Thanks for calling. How can I help you today?',
//   no: 'Hallo! Hvordan kan jeg hjelpe deg i dag?',
//   ar: 'مرحباً! كيف يمكنني مساعدتك اليوم؟',
//   de: 'Hallo! Vielen Dank für Ihren Anruf. Wie kann ich Ihnen helfen?',
//   fr: 'Bonjour ! Merci d’avoir appelé. Comment puis-je vous aider ?',
//   es: '¡Hola! Gracias por llamar. ¿En qué puedo ayudarle?',
//   it: 'Ciao! Grazie per aver chiamato. Come posso aiutarla?',
//   pt: 'Olá! Obrigado por ligar. Como posso ajudá-lo?',
//   nl: 'Hallo! Bedankt voor uw oproep. Hoe kan ik u helpen?',
//   sv: 'Hej! Tack för att du ringde. Hur kan jag hjälpa dig?',
//   da: 'Hej! Tak for dit opkald. Hvordan kan jeg hjælpe dig?',
//   fi: 'Hei! Kiitos soitostasi. Miten voin auttaa?',
//   pl: 'Dzień dobry! Dziękujemy za telefon. W czym mogę pomóc?',
//   ru: 'Здравствуйте! Спасибо за звонок. Чем могу помочь?',
//   uk: 'Вітаю! Дякую за дзвінок. Чим можу допомогти?',
//   cs: 'Dobrý den! Děkujeme za hovor. Jak vám mohu pomoci?',
//   sk: 'Dobrý deň! Ďakujeme za hovor. Ako vám môžem pomôcť?',
//   sl: 'Dober dan! Hvala za klic. Kako vam lahko pomagam?',
//   hu: 'Jó napot! Köszönjük a hívást. Miben segíthetek?',
//   ro: 'Bună ziua! Vă mulțumim pentru apel. Cu ce vă pot ajuta?',
//   bg: 'Здравейте! Благодарим за обаждането. Как мога да помогна?',
//   hr: 'Dobar dan! Hvala na pozivu. Kako vam mogu pomoći?',
//   sr: 'Dobar dan! Hvala na pozivu. Kako vam mogu pomoći?',
//   el: 'Γεια σας! Ευχαριστούμε για την κλήση. Πώς μπορώ να βοηθήσω;',
//   he: 'שלום! תודה שיצרת קשר. איך אפשר לעזור?',
//   ja: 'こんにちは。お電話ありがとうございます。何かお手伝いできることはありますか？',
//   zh: '您好！感谢您的来电。请问有什么可以帮您？',
//   ko: '안녕하세요, 연락 주셔서 감사합니다. 무엇을 도와드릴까요?',
//   hi: 'नमस्ते! कॉल करने के लिए धन्यवाद। मैं आपकी कैसे मदद कर सकता हूँ?',
//   tr: 'Merhaba! Araydığınız için teşekkürler. Size nasıl yardımcı olabilirim?',
//   vi: 'Xin chào! Cảm ơn bạn đã gọi. Tôi có thể giúp gì cho bạn?',
//   id: 'Halo! Terima kasih telah menelepon. Ada yang bisa saya bantu?',
//   ms: 'Helo! Terima kasih kerana menelefon. Bagaimana saya boleh membantu?',
//   fil: 'Kumusta! Salamat sa tawag. Paano kita matutulungan?',
//   sw: 'Habari! Asante kwa kupiga simu. Ninaweza kukusaidia vipi?',
//   bn: 'নমস্কার! কল করার জন্য ধন্যবাদ। আমি কীভাবে সাহায্য করতে পারি?',
//   ta: 'வணக்கம்! அழைத்ததற்கு நன்றி. நான் எப்படி உதவலாம்?',
//   te: 'నమస్కారం! కాల్ చేసినందుకు ధన్యవాదాలు. నేను ఎలా సహాయం చేయగలను?',
//   ur: 'السلام علیکم! کال کرنے کا شکریہ۔ میں کیسے مدد کر سکتا ہوں؟',
//   fa: 'سلام! با تشکر از تماس شما. چطور می‌توانم کمک کنم؟',
//   ca: 'Hola! Gràcies per trucar. En què puc ajudar-lo?',
//   eu: 'Kaixo! Eskerrik asko deitzagatik. Nola lagun zaitzaket?',
//   gl: 'Ola! Grazas por chamar. En que podo axudar?',
//   cy: 'Helo! Diolch am ffonio. Sut alla i helpu?',
//   ga: 'Dia dhuit! Go raibh maith agat as glaoch. Conas is féidir liom cabhrú?',
//   is: 'Halló! Takk fyrir að hringja. Hvernig get ég aðstoðað?',
//   mk: 'Здраво! Ви благодариме за повикот. Како можам да помогнам?',
//   sq: 'Përshëndetje! Faleminderit që telefonuat. Si mund t’ju ndihmoj?',
//   lv: 'Sveiki! Paldies par zvanu. Kā varu palīdzēt?',
//   lt: 'Sveiki! Ačiū už skambutį. Kaip galiu padėti?',
//   et: 'Tere! Täname helistamise eest. Kuidas saan aidata?',
//   kk: 'Сәлеметсіз бе! Қоңырау үшін рахмет. Қалай көмектесе аламын?',
//   uz: 'Assalomu alaykum! Qo‘ng‘iroq uchun rahmat. Qanday yordam bera olaman?',
//   az: 'Salam! Zəng etdiyiniz üçün təşəkkür edirəm. Sizə necə kömək edə bilərəm?',
//   ka: 'გამარჯობა! გმადლობთ ზარს. როგორ შემიძლია დაგეხმაროთ?',
//   hy: 'Ողջույն։ Շնորհակալություն զանգի համար։ Ինչպե՞ս կարող եմ օգնել։',
//   my: 'မင်္ဂလာပါ။ ခေါ်ဆိုမှုအတွက် ကျေးဇူးတင်ပါတယ်။ ဘယ်လိုကူညီပေးရမလဲ။',
//   km: 'សួស្តី! សូមអរគុណសម្រាប់ការហៅ។ តើខ្ញុំអាចជួយអ្នកយ៉ាងណា?',
//   si: 'හෙලෝ! ඇමතුමට ස්තූතියි. මම ඔබට කෙසේ උදව් කළ හැකිද?',
//   ne: 'नमस्ते! कल गर्नुभएकोमा धन्यवाद। म कसरी मद्दत गर्न सक्छु?',
//   mr: 'नमस्कार! कॉल केल्याबद्दल धन्यवाद. मी कशी मदत करू शकते?',
//   gu: 'નમસ્તે! કૉલ કરવા બદલ આભાર. હું કેવી રીતે મદદ કરી શકું?',
//   kn: 'ನಮಸ್ಕಾರ! ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾನು ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?',
//   ml: 'നമസ്കാരം! വിളിച്ചതിന് നന്ദി. എനിക്ക് എങ്ങനെ സഹായിക്കാനാകും?',
//   pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਕਾਲ ਕਰਨ ਲਈ ਧੰਨਵਾਦ। ਮੈਂ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?',
//   th: 'สวัสดีครับ/ค่ะ ขอบคุณที่โทรมา มีอะไรให้ช่วยไหมครับ/คะ?',
// };
export const DEFAULT_SCRIPT_OPENINGS: Record<string, string> = {
  en: 'Hello! How can I assist you today?',
  no: 'Hei! Hvordan kan jeg hjelpe deg i dag?',
  ar: 'مرحباً! كيف يمكنني مساعدتك اليوم؟',
  de: 'Hallo! Wie kann ich Ihnen heute helfen?',
  fr: 'Bonjour ! Comment puis-je vous aider aujourd’hui ?',
  es: '¡Hola! ¿En qué puedo ayudarte hoy?',
  it: 'Ciao! Come posso aiutarti oggi?',
  pt: 'Olá! Como posso ajudar você hoje?',
  nl: 'Hallo! Hoe kan ik u vandaag helpen?',
  sv: 'Hej! Hur kan jag hjälpa dig idag?',
  da: 'Hej! Hvordan kan jeg hjælpe dig i dag?',
  fi: 'Hei! Kuinka voin auttaa sinua tänään?',
  pl: 'Dzień dobry! W czym mogę pomóc dzisiaj?',
  ru: 'Здравствуйте! Чем могу помочь сегодня?',
  uk: 'Вітаю! Чим можу допомогти сьогодні?',
  cs: 'Dobrý den! Jak vám mohu pomoci dnes?',
  sk: 'Dobrý deň! Ako vám môžem pomôcť dnes?',
  sl: 'Dober dan! Kako vam lahko pomagam danes?',
  hu: 'Jó napot kívánok! Miben segíthetek ma?',
  ro: 'Bună ziua! Cum vă pot ajuta astăzi?',
  bg: 'Здравейте! Как мога да ви помогна днес?',
  hr: 'Dobar dan! Kako vam mogu pomoći danas?',
  sr: 'Dobar dan! Kako mogu da vam pomognem danas?',
  el: 'Γεια σας! Πώς μπορώ να σας βοηθήσω σήμερα;',
  he: 'שלום! איך אפשר לעזור לך היום?',
  ja: 'こんにちは、今日はどのようにお手伝いできますか？',
  zh: '您好！今天我能如何为您服务？',
  ko: '안녕하세요, 무엇을 도와드릴까요?',
  hi: 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?',
  tr: 'Merhaba, Size nasıl yardımcı olabilirim?',
  vi: 'Xin chào, tôi có thể giúp gì cho bạn hôm nay?',
  id: 'Halo, Ada yang bisa saya bantu hari ini?',
  ms: 'Helo, Bagaimana saya boleh membantu anda hari ini?',
  fil: 'Kumusta, Paano kita matutulungan ngayon?',
  sw: 'Habari, Ninaweza kukusaidia vipi leo?',
  bn: 'নমস্কার, আমি কীভাবে সাহায্য করতে পারি?',
  ta: 'வணக்கம், நான் எப்படி உதவலாம்?',
  te: 'నమస్కారం, నేను ఎలా సహాయం చేయగలను?',
  ur: 'السلام علیکم! میں کیسے مدد کر سکتا ہوں؟',
  fa: 'سلام! چطور می‌توانم امروز به شما کمک کنم؟',
  ca: 'Hola! Com et puc ajudar avui?',
  eu: 'Kaixo! Nola lagundu zaitzaket gaur?',
  gl: 'Ola! Como podo axudarche hoxe?',
  cy: 'Helo! Sut alla i helpu heddiw?',
  ga: 'Dia dhuit! Conas is féidir liom cabhrú leat inniu?',
  is: 'Halló! Hvernig get ég hjálpað þér í dag?',
  mk: 'Здраво! Како можам да ви помогнам денес?',
  sq: 'Përshëndetje! Si mund t’ju ndihmoj sot?',
  lv: 'Sveiki! Kā varu jums palīdzēt šodien?',
  lt: 'Sveiki! Kaip galiu jums padėti šiandien?',
  et: 'Tere! Kuidas saan täna aidata?',
  kk: 'Сәлеметсіз бе! Қалай көмектесе аламын?',
  uz: 'Assalomu alaykum! Bugun sizga qanday yordam bera olishim mumkin?',
  az: 'Salam! Necə kömək edə bilərəm?',
  ka: 'გამარჯობა! როგორ შემიძლია დაგეხმაროთ დღეს?',
  hy: 'Ողջույն! Ինչպես կարող եմ օգնել ձեզ այսօր։',
  my: 'မင်္ဂလာပါ၊ ဘယ်လိုကူညီပေးရမလဲ။',
  km: 'សួស្តី! តើខ្ញុំអាចជួយអ្នកអ្វីបានខ្លះថ្ងៃនេះ?',
  si: 'හෙලෝ! මට උදව් කළ හැක්කේ කෙසේද?',
  ne: 'नमस्ते! म तपाईंलाई आज कस्तो मद्दत पुर्‍याउन सक्छु?',
  mr: 'नमस्कार! मी तुम्हाला कशी मदत करू शकतो?',
  gu: 'નમસ્તે! હું તમને કેવી રીતે મદદ કરી શકું?',
  kn: 'ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?',
  ml: 'നമസ്കാരം! എനിക്ക് എങ്ങനെ സഹായിക്കാനാകും?',
  pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?',
  th: 'สวัสดีครับ/ค่ะ วันนี้ผม/ฉันสามารถช่วยอะไรได้บ้างครับ/คะ?',
};

/** @deprecated Use defaultScriptOpeningMessage('ar') */
export const ARABIC_DEFAULT_FIRST_MESSAGE = DEFAULT_SCRIPT_OPENINGS.ar;
