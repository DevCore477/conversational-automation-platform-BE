import type { MakeCallInput } from '../dto/make-call.dto';
import type { TrustedCallerAttribution } from '../utils/trusted-caller-attribution.util';

export const OUTBOUND_CALL_QUEUE = 'outbound-calls';

export interface DialCallJobPayload {
  kind: 'dial-call';
  /** Caller-assigned id, stable across the queued -> dialed -> active -> terminal lifecycle,
   *  used before a provider callSid exists yet (i.e. while status is still `queued`). */
  callQueueId: string;
  dto: MakeCallInput;
  companyId?: string;
  trustedCaller?: TrustedCallerAttribution;
  /** Where this job was enqueued from — surfaced in logs/metrics only. */
  source: 'api' | 'royal-transfer-driver-reminder' | 'other';
}

export type OutboundCallJobPayload = DialCallJobPayload;

/** Progress payload reported mid-job via `job.updateProgress()`, observed by producers through
 *  BullMQ's QueueEvents (works across processes/instances — required for horizontal scaling). */
export type OutboundCallProgress =
  | { phase: 'dialing' }
  | { phase: 'dialed'; callSid: string; provider: string; result: Record<string, unknown> }
  | { phase: 'dial-failed'; error: string; permanent: boolean };

export interface OutboundCallJobResult {
  callSid?: string;
  /** Terminal outcome once the call ended, or undefined if the dial itself never succeeded. */
  outcome: 'answered' | 'busy' | 'no_answer' | 'cancelled' | 'failed' | 'timeout' | 'dial_failed';
  providerStatus?: string;
  error?: string;
}

export function isOutboundCallProgress(value: unknown): value is OutboundCallProgress {
  return typeof value === 'object' && value !== null && 'phase' in value;
}
