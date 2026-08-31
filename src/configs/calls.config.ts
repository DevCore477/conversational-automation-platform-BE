import { registerAs } from '@nestjs/config';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-IP limit for anonymous POST /calls when Origin matches trusted URLs (verified frontend). */
export default registerAs('calls', () => ({
  frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? process.env.APP_BASE_URL,
  backendBaseUrl: process.env.BACKEND_BASE_URL ?? process.env.APP_BASE_URL,
  /** Max outbound call creations per client IP per window from a trusted Origin (default 3). */
  trustedOriginIpMax: parsePositiveInt(process.env.CALLS_TRUSTED_ORIGIN_IP_MAX, 3),
  /** Sliding window in ms (default 7 days). Set e.g. 86400000 for one day. */
  trustedOriginIpWindowMs: parsePositiveInt(
    process.env.CALLS_TRUSTED_ORIGIN_IP_WINDOW_MS,
    7 * 24 * 60 * 60 * 1000,
  ),
  /** When true (default), trusted-origin + JWT/API user skips the strict per-IP cap. */
  trustedOriginIpLimitExemptWhenAuthenticated:
    (
      process.env.CALLS_TRUSTED_ORIGIN_IP_LIMIT_EXEMPT_WHEN_AUTHENTICATED ?? 'true'
    ).toLowerCase() !== 'false',
  /** Anonymous requests from non-trusted origins (default 10 per 15 minutes). */
  untrustedAnonymousMax: parsePositiveInt(process.env.CALLS_UNTRUSTED_ANON_IP_MAX, 3),
  untrustedAnonymousWindowMs: parsePositiveInt(
    process.env.CALLS_UNTRUSTED_ANON_IP_WINDOW_MS,
    24 * 60 * 60 * 1000,
  ),
  /**
   * When true, POST /calls never dials Twilio (terminal simulation only).
   * Overrides development auto-skip below.
   */
  skipTwilioOutbound:
    process.env.SKIP_TWILIO_OUTBOUND === 'true' || process.env.SKIP_TWILIO_OUTBOUND === '1',
  /**
   * In development/test, POST /calls uses terminal chat instead of Twilio unless
   * USE_REAL_TWILIO_OUTBOUND=true (needs valid Twilio env). Production is unaffected.
   */
  useRealTwilioOutboundDev:
    process.env.USE_REAL_TWILIO_OUTBOUND === 'true' || process.env.USE_REAL_TWILIO_OUTBOUND === '1',
  /**
   * Which provider real (non-simulated) outbound dials use:
   * - 'auto' (default): try Twilio first, fall back to Telnyx on any Twilio error — preserves the
   *   historical dual-provider behavior for deployments that actually run both.
   * - 'telnyx': skip Twilio entirely — no health check, no dial attempt, no fallback logic. Every
   *   outbound call goes straight to Telnyx. Set this when Twilio is not a real provider for this
   *   deployment; attempting it first only adds a guaranteed-to-fail network round trip (and, if
   *   Twilio credentials happen to be *validly* configured for something else, could place a real
   *   call through the wrong provider).
   * - 'twilio': only Twilio; never fall back to Telnyx.
   */
  outboundTelephonyProvider: (process.env.OUTBOUND_TELEPHONY_PROVIDER ?? 'auto').toLowerCase() as
    | 'auto'
    | 'telnyx'
    | 'twilio',
}));
