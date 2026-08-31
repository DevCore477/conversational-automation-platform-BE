/**
 * Normalizes a phone number for outbound calls (e.g. Twilio E.164).
 * Handles formats like: +92-333-6060197, 92 333 6060197, 923336060197
 * by stripping spaces, dashes, etc. and returning +<digits>.
 * Returns empty string if input has no digits.
 */
export function normalizePhoneNumber(raw: string | null | undefined): string {
  if (raw == null || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  return `+${digits}`;
}

/**
 * True when a (typically already `normalizePhoneNumber`-passed) value could plausibly be a real
 * phone number: `+` followed by 8-15 digits, per the E.164 maximum length (ITU-T E.164 §6.1), first
 * digit non-zero. Guards call-transfer code against sending a non-phone value (an id, a garbage
 * metadata override, a UUID with hyphens stripped) to Telnyx/Twilio, where it reliably fails as an
 * opaque 422 far from the actual misconfiguration — this catches it earlier with a clear log line.
 */
export function isPlausibleE164Number(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}
