import { normalizePhoneNumber } from './phone.util';

/**
 * E.164 country code prefix for Norway.
 * Used to route inbound calls to the correct script/language.
 */
const NORWAY_COUNTRY_CODE = '+47';

/**
 * Returns true if the caller's number is from Norway (+47).
 * Use this to route inbound calls to the Norwegian vet script.
 */
export function isNorwegianNumber(from: string | null | undefined): boolean {
  if (!from || typeof from !== 'string') return false;
  const normalized = from.trim();
  return normalized.startsWith(NORWAY_COUNTRY_CODE);
}

/**
 * Country code to language mapping.
 * Used to set AI voice language based on the called number (e.g. +47 Norway → Norwegian).
 */
const COUNTRY_TO_LANGUAGE: Record<string, string> = {
  '+47': 'no', // Norway
  '+44': 'en', // UK
  '+46': 'sv', // Sweden
  '+45': 'da', // Denmark
  '+49': 'de', // Germany
  '+33': 'fr', // France
  '+31': 'nl', // Netherlands
  '+34': 'es', // Spain
};

/**
 * Returns the language code for a phone number based on its country code.
 * Used when resolving inbound script: the called number's country decides language.
 */
export function getLanguageFromCountryCode(phone: string | null | undefined): string {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return 'en';
  for (const [prefix, lang] of Object.entries(COUNTRY_TO_LANGUAGE)) {
    if (normalized.startsWith(prefix)) return lang;
  }
  return 'en';
}
