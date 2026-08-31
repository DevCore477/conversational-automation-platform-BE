/**
 * Final, human-facing outcome of one dialed call — distinct from `CallStatus` (the technical
 * live-call state machine). Used by the outbound queue/worker to decide whether a failure is
 * worth retrying and to report a status the "queued/ringing/answered/busy/no_answer" vocabulary
 * expects, without touching the already-correct, deeply-tested `CallStatus` transitions used by
 * the webhook/voice-bridge live-call path.
 */
export type CallOutcome = 'answered' | 'busy' | 'no_answer' | 'cancelled' | 'failed' | 'timeout';

/** Terminal provider call statuses (Twilio `CallStatus` / normalized Telnyx state) -> outcome. */
export function classifyProviderStatus(status: string | undefined): CallOutcome | undefined {
  switch (status) {
    case 'completed':
      return 'answered';
    case 'busy':
      return 'busy';
    case 'no-answer':
    case 'no_answer':
      return 'no_answer';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

/** SIP hangup causes that mean "this number/route will never succeed" — retrying is pointless. */
const PERMANENT_SIP_CAUSES = new Set(['403', '404', '486', '487', '603']);

/** Twilio REST error codes that indicate a permanent condition (bad number/config), not a
 *  transient provider hiccup — retrying with the same input cannot succeed. */
const PERMANENT_TWILIO_ERROR_CODES = new Set([21211, 21212, 21614, 21610, 21617]);

export interface DialFailureClassification {
  /** true = retrying will not help (bad number, rejected, no credit); false = worth a retry. */
  permanent: boolean;
  reason: string;
}

/**
 * Classifies a dial-time failure (thrown by CallsService.makeCall / CallRetryService.retryCall)
 * as permanent (do not retry — mark the call failed/busy immediately) or transient (safe to let
 * the queue's backoff+retry policy try again). Defaults to permanent for anything unrecognized
 * so a genuinely unknown error doesn't blindly retry-storm a number that will never pick up.
 */
export function classifyDialFailure(err: unknown): DialFailureClassification {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes('invalid phone number') ||
    lower.includes('invalid caller') ||
    lower.includes('not a valid mobile number') ||
    lower.includes('not configured') ||
    lower.includes('is not published') ||
    lower.includes('is not active') ||
    lower.includes('insufficient balance')
  ) {
    return { permanent: true, reason: message };
  }

  const twilioCode = extractTwilioErrorCode(err);
  if (twilioCode !== undefined && PERMANENT_TWILIO_ERROR_CODES.has(twilioCode)) {
    return { permanent: true, reason: message };
  }

  const sipCause = extractSipHangupCause(err);
  if (sipCause !== undefined && PERMANENT_SIP_CAUSES.has(sipCause)) {
    return { permanent: true, reason: message };
  }

  // Network blips, provider 5xx, timeouts, etc — safe to retry.
  return { permanent: false, reason: message };
}

function extractTwilioErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

function extractSipHangupCause(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'sipHangupCause' in err) {
    const cause = (err as { sipHangupCause?: unknown }).sipHangupCause;
    return typeof cause === 'string' ? cause : undefined;
  }
  return undefined;
}
