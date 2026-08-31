import { registerAs } from '@nestjs/config';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Concurrency + reliability knobs for the outbound call queue and inbound call admission
 * control. Nothing here is hard-coded into the queue/worker/webhook code — every limit is
 * read from here so operators can tune capacity (and respect telephony-provider limits)
 * without a code change.
 */
export default registerAs('callQueue', () => ({
  /** Hard cap on simultaneously ACTIVE calls (inbound + outbound combined) across this deployment. */
  maxConcurrentCalls: parsePositiveInt(process.env.MAX_CONCURRENT_CALLS, 50),
  /** Max outbound calls the BullMQ worker will dial/hold open at once (its `concurrency`). */
  maxConcurrentOutboundCalls: parsePositiveInt(process.env.MAX_CONCURRENT_OUTBOUND_CALLS, 10),
  /** Max inbound calls admitted (answered) at once before new inbound calls are rejected as busy. */
  maxConcurrentInboundCalls: parsePositiveInt(process.env.MAX_CONCURRENT_INBOUND_CALLS, 20),
  /** Outbound dial rate limit: at most this many NEW dials started per `dialRateLimitWindowMs`. */
  dialRateLimitPerWindow: parsePositiveInt(process.env.CALL_QUEUE_DIAL_RATE_LIMIT, 5),
  dialRateLimitWindowMs: parsePositiveInt(process.env.CALL_QUEUE_DIAL_RATE_LIMIT_WINDOW_MS, 1000),
  /** Retry attempts for a *transient* dial/provider failure (not user_busy/invalid number/etc). */
  retryLimit: parsePositiveInt(process.env.CALL_QUEUE_RETRY_LIMIT, 2),
  /** Base backoff between retries; BullMQ applies exponential backoff from this base. */
  retryBackoffMs: parsePositiveInt(process.env.CALL_QUEUE_RETRY_BACKOFF_MS, 5000),
  /** Safety-net max lifetime for one call (queued -> dialed -> active -> terminal) before the
   *  worker force-releases its concurrency slot and marks the call FAILED (timeout). */
  callTimeoutMs: parsePositiveInt(process.env.CALL_TIMEOUT_MS, 10 * 60 * 1000),
  /** How often the worker polls provider call status while a dialed call is in progress. */
  callStatusPollIntervalMs: parsePositiveInt(process.env.CALL_STATUS_POLL_INTERVAL_MS, 2000),
  /** How long POST /calls waits for the queue to report "dialed" (callSid assigned) before
   *  falling back to a 202 queued response instead of blocking the HTTP request indefinitely. */
  dialAckTimeoutMs: parsePositiveInt(process.env.CALL_QUEUE_DIAL_ACK_TIMEOUT_MS, 30_000),
  /** How long a job's Redis lock is held before BullMQ considers the worker holding it dead if
   *  it stops renewing (e.g. process crash). Renewed automatically at half this interval while
   *  the worker is alive, so this does NOT need to cover a call's full duration — only how fast
   *  a genuine crash should be detected. */
  lockDurationMs: parsePositiveInt(process.env.CALL_QUEUE_LOCK_DURATION_MS, 30_000),
  /** How often BullMQ scans for stalled jobs (locks that expired without renewal). */
  stalledIntervalMs: parsePositiveInt(process.env.CALL_QUEUE_STALLED_INTERVAL_MS, 30_000),
  /** Bound on any single Redis command issued directly by admission-control/enqueue code paths.
   *  Required because BullMQ mandates `maxRetriesPerRequest: null`, under which ioredis retries
   *  a command forever (never resolves, never rejects) while Redis is unreachable — without this
   *  bound, "fail safely" logic around such a command would never actually run. */
  redisOpTimeoutMs: parsePositiveInt(process.env.CALL_QUEUE_REDIS_OP_TIMEOUT_MS, 2_000),
}));
