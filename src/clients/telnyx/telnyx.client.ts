import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { retryWithBackoff } from '../../common/utils/retry-with-backoff.util';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Thrown by `TelnyxClient.request`. Carries whether the failure looks transient (network error,
 * timeout, 429, 5xx) so callers/retry logic can distinguish "try again" from "this will never work"
 * (bad params, auth, 4xx) instead of retrying — or giving up — blindly.
 */
export class TelnyxRequestError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'TelnyxRequestError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/** Telnyx returns a 4xx/409-shaped error when a call-control action no longer applies (already
 * answered, already streaming, call torn down mid-command). These are not failures — a concurrent
 * or redelivered command already achieved the desired state — so treat them as a successful no-op
 * rather than surfacing an error that would otherwise be mis-reported as a dropped/failed call. */
function isAlreadyInDesiredStateError(message: string): boolean {
  return /already (answered|bridging|hung ?up|streaming|active)|not in a (valid|correct) state|no active call/i.test(
    message,
  );
}

/**
 * Telnyx `call_control_id` values (e.g. `v3:QBzEl5FeR6jV-kIfC-hbZjKjLkvK_r6hN50JZ0u7_UPeSy7JD8xFKA`)
 * are always base64url characters (`A-Za-z0-9-_`) plus a literal `:` version-prefix separator. A
 * colon is a legal, unescaped character within a URL path segment (RFC 3986 `pchar` explicitly
 * includes `:`), so it must be interpolated as-is — NOT run through `encodeURIComponent`, which
 * percent-encodes it to `%3A`. Telnyx's call-control routing does not treat `%3A` as equivalent to
 * `:` when resolving the id from the path: a percent-encoded colon fails the lookup on their side
 * and surfaces back to us as a generic `500 Internal Server Error` (or a hung request that times
 * out) instead of a clean 404 — exactly the failure this project hit on every `streaming_start`
 * call. Encoding was never necessary here since the id never contains characters that need it.
 */
function callControlIdPathSegment(callControlId: string): string {
  return callControlId;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_ATTEMPTS = 3;

/**
 * `answerCall` / `startBidirectionalStream` run *while the caller is live on the line* — every
 * second spent retrying is dead air. A 500 from Telnyx on these commands has repeatedly turned out
 * to be a hard failure for that specific parameter set (not something a same-request retry fixes),
 * while the caller hangs up waiting. So these get a short timeout and effectively no same-request
 * retry — the caller (webhook controller) instead fails over to a different target/strategy fast,
 * which is far more likely to actually succeed than repeating an identical request that just failed.
 */
const IN_CALL_ACTION_TIMEOUT_MS = 4_000;
const IN_CALL_ACTION_RETRY_ATTEMPTS = 1;

export class TelnyxClient {
  private readonly baseUrl = 'https://api.telnyx.com/v2';
  private readonly logger = new Logger(TelnyxClient.name);

  constructor(
    private readonly apiKey: string,
    private readonly connectionId: string,
  ) {}

  isConfigured(): boolean {
    return this.apiKey !== '' && this.connectionId !== '';
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const payload = await this.request<JsonRecord>('/balance');
    return isRecord(payload.data);
  }

  async getAccountBalance(): Promise<{ availableCredit: string; currency: string }> {
    const payload = await this.request<JsonRecord>('/balance');
    const data = isRecord(payload.data) ? payload.data : {};
    const available = data.available_credit;
    const currency = data.currency;
    return {
      availableCredit: typeof available === 'string' ? available : '0',
      currency: typeof currency === 'string' ? currency : 'USD',
    };
  }

  async call(to: string, from: string, webhookUrl: string): Promise<string> {
    // Generated once and reused across retry attempts: if a request times out after Telnyx already
    // accepted it, a naive retry would dial the destination a second time. Sending the same
    // Idempotency-Key lets Telnyx recognize the retry and return the original call instead of
    // placing a duplicate one.
    const idempotencyKey = randomUUID();

    const payload = await retryWithBackoff(
      () =>
        this.request<JsonRecord>('/calls', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({
            connection_id: this.connectionId,
            to,
            from,
            webhook_url: webhookUrl,
            webhook_url_method: 'POST',
          }),
        }),
      {
        attempts: DEFAULT_RETRY_ATTEMPTS,
        isRetryable: err => err instanceof TelnyxRequestError && err.retryable,
      },
    );

    const data = isRecord(payload.data) ? payload.data : {};
    const callControlId = data.call_control_id;
    if (typeof callControlId !== 'string' || callControlId === '') {
      throw new Error('Telnyx call creation succeeded without call_control_id');
    }
    return callControlId;
  }

  async answerCall(callControlId: string): Promise<void> {
    try {
      await retryWithBackoff(
        () =>
          this.request(
            `/calls/${callControlIdPathSegment(callControlId)}/actions/answer`,
            { method: 'POST', body: JSON.stringify({}) },
            IN_CALL_ACTION_TIMEOUT_MS,
          ),
        {
          attempts: IN_CALL_ACTION_RETRY_ATTEMPTS,
          isRetryable: err => err instanceof TelnyxRequestError && err.retryable,
        },
      );
      this.logger.log(`✅ answerCall succeeded for call_control_id=${callControlId}`);
    } catch (err) {
      if (err instanceof Error && isAlreadyInDesiredStateError(err.message)) {
        this.logger.log(
          `↩️ answerCall for ${callControlId} reported "${err.message}" — treating as already answered`,
        );
        return; // A concurrent/redelivered answer already succeeded — nothing left to do.
      }
      throw err;
    }
  }

  /**
   * Start bidirectional media streaming (RTP over WebSocket). Caller-supplied `targetLegs` picks
   * the routing: `'self'` targets only the leg audio was injected on (theoretically the "cleanest"
   * routing for inbound — see the webhook controller's target-order comment for why it's tried
   * second in practice), `'opposite'` targets the other leg (can 500 on some outbound legs), `'both'`
   * targets every leg (most reliable in practice for both directions, at the cost of a possible
   * duplicate audio path). Retries are intentionally minimal here — see
   * `IN_CALL_ACTION_RETRY_ATTEMPTS` — this runs while the caller is live on the line, so failing
   * fast to let the caller try another target matters far more than retrying an identical request
   * that just failed.
   *
   * Payload intentionally omits `stream_track` / `stream_codec`: per Telnyx's Call Control API
   * reference (developers.telnyx.com/api/call-control/start-call-streaming), those two fields
   * belong to the older, unidirectional Media Streaming feature and are independent of the
   * `stream_bidirectional_*` fields used here. Telnyx's docs don't forbid sending both, but doing so
   * asks Telnyx to set up two different streaming mechanisms against the same `stream_url` in one
   * call — and Telnyx documents a hard limit of exactly one bidirectional RTP stream per call. That
   * combination reproduced a consistent `500 Internal Server Error` from `streaming_start` in this
   * project every time it was attempted; the minimal, bidirectional-only request below is what
   * Telnyx's bidirectional streaming examples show.
   */
  async startBidirectionalStream(
    callControlId: string,
    streamUrl: string,
    targetLegs: 'self' | 'opposite' | 'both' = 'both',
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await retryWithBackoff(
        () =>
          this.request(
            `/calls/${callControlIdPathSegment(callControlId)}/actions/streaming_start`,
            {
              method: 'POST',
              body: JSON.stringify({
                stream_url: streamUrl,
                stream_bidirectional_mode: 'rtp',
                stream_bidirectional_codec: 'L16',
                stream_bidirectional_sampling_rate: 16000,
                stream_bidirectional_target_legs: targetLegs,
              }),
            },
            IN_CALL_ACTION_TIMEOUT_MS,
          ),
        {
          attempts: IN_CALL_ACTION_RETRY_ATTEMPTS,
          isRetryable: err => err instanceof TelnyxRequestError && err.retryable,
        },
      );
      this.logger.log(
        `✅ streaming_start (${targetLegs}) succeeded for call_control_id=${callControlId} in ${String(Date.now() - startedAt)}ms`,
      );
    } catch (err) {
      if (err instanceof Error && isAlreadyInDesiredStateError(err.message)) {
        this.logger.log(
          `↩️ streaming_start (${targetLegs}) for ${callControlId} reported "${err.message}" — treating as already streaming`,
        );
        return; // A concurrent/redelivered streaming_start already succeeded.
      }
      this.logger.warn(
        `streaming_start (${targetLegs}) failed for call_control_id=${callControlId} after ${String(Date.now() - startedAt)}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * The Telnyx call resource (`GET /calls/{id}`) does not return a `call_status` string enum —
   * that field never appears in the actual response (confirmed against live payloads: it returns
   * `is_alive`, `call_control_id`, `call_leg_id`, `call_session_id`, `record_type`). A prior version
   * of this method read `data.call_status`, which is always `undefined` here, so this always
   * returned `'unknown'` regardless of the call's real state — silently breaking every caller that
   * polls this to detect call completion (e.g. `CallsService.waitForCallToEnd`). Normalize
   * `is_alive` into the same terminal vocabulary `waitForCallToEnd` already checks for ('ended' is
   * in its `TERMINAL_CALL_STATUSES` set).
   */
  async getCallStatus(callControlId: string): Promise<string> {
    const payload = await retryWithBackoff(
      () => this.request<JsonRecord>(`/calls/${callControlIdPathSegment(callControlId)}`),
      {
        attempts: DEFAULT_RETRY_ATTEMPTS,
        isRetryable: err => err instanceof TelnyxRequestError && err.retryable,
      },
    );
    const data = isRecord(payload.data) ? payload.data : {};
    const isAlive = data.is_alive;
    if (typeof isAlive === 'boolean') {
      return isAlive ? 'active' : 'ended';
    }
    // Fall back in case a future/older API version does return a literal status string.
    const status = data.call_status;
    return typeof status === 'string' ? status : 'unknown';
  }

  /** Headers as a plain object for logging, with the bearer token redacted. */
  private static redactedHeaders(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) =>
        key.toLowerCase() === 'authorization' ? [key, '[redacted]'] : [key, value],
      ),
    );
  }

  private async request<T extends JsonRecord>(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<{ data: T | undefined }> {
    if (this.apiKey === '') {
      throw new Error('TELNYX_API_KEY is not configured');
    }

    const method = init.method ?? 'GET';
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    const startedAt = Date.now();
    this.logger.debug(
      `→ Telnyx ${method} ${path} headers=${JSON.stringify(TelnyxClient.redactedHeaders(requestHeaders))} body=${typeof init.body === 'string' ? init.body : 'n/a'}`,
    );

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: requestHeaders,
      });
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      // Network failure or our own timeout abort — Telnyx never responded, safe to treat as transient.
      const timedOut = err instanceof Error && err.name === 'AbortError';
      this.logger.warn(
        `← Telnyx ${method} ${path} ${timedOut ? 'timed out' : 'network error'} after ${String(elapsedMs)}ms: ${err instanceof Error ? err.stack : String(err)}`,
      );
      throw new TelnyxRequestError(
        timedOut
          ? `Telnyx request to ${path} timed out after ${String(timeoutMs)}ms`
          : `Telnyx request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    const elapsedMs = Date.now() - startedAt;
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const rawBodyText = await response.text();
    let body: JsonRecord = {};
    try {
      body = rawBodyText === '' ? {} : (JSON.parse(rawBodyText) as JsonRecord);
    } catch {
      // Non-JSON body (e.g. an HTML error page from an intermediary) — logged raw above/below.
    }
    if (!response.ok) {
      const errors = Array.isArray(body.errors) ? body.errors : [];
      const first = errors[0];
      const detail =
        isRecord(first) && typeof first.detail === 'string'
          ? first.detail
          : `Telnyx request failed with status ${String(response.status)}`;
      // 429 (rate limited) and 5xx (Telnyx-side transient fault) are worth retrying; 4xx (bad
      // params, unauthorized, not found) will fail identically every time.
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.warn(
        `← Telnyx ${method} ${path} → ${String(response.status)} in ${String(elapsedMs)}ms\n` +
          `  response headers: ${JSON.stringify(responseHeaders)}\n` +
          `  response body: ${rawBodyText}`,
      );
      throw new TelnyxRequestError(detail, { retryable, status: response.status });
    }

    this.logger.debug(
      `← Telnyx ${method} ${path} → ${String(response.status)} in ${String(elapsedMs)}ms body=${rawBodyText}`,
    );

    return {
      data: isRecord(body.data) ? (body.data as T) : undefined,
    };
  }
  /**
   * Hang up an active call. Pass Telnyx `call_control_id` only — not our internal `TLX_${id}` prefix.
   */
  async endCall(callControlId: string): Promise<void> {
    const id = callControlId.startsWith('TLX_') ? callControlId.slice(4) : callControlId;
    try {
      await retryWithBackoff(
        () =>
          this.request(`/calls/${callControlIdPathSegment(id)}/actions/hangup`, {
            method: 'POST',
            body: JSON.stringify({}),
          }),
        {
          attempts: DEFAULT_RETRY_ATTEMPTS,
          isRetryable: err => err instanceof TelnyxRequestError && err.retryable,
        },
      );
    } catch (err) {
      if (err instanceof Error && isAlreadyInDesiredStateError(err.message)) {
        return; // Already hung up (e.g. by the far end) — nothing left to do.
      }
      throw err;
    }
  }

  /**
   * Stop bidirectional media streaming before transfer or teardown. Runs while the caller is live
   * on the line, so it gets the same short timeout / minimal-retry treatment as `startBidirectionalStream`.
   */
  async stopBidirectionalStream(callControlId: string): Promise<void> {
    const id = callControlId.startsWith('TLX_') ? callControlId.slice(4) : callControlId;
    try {
      await retryWithBackoff(
        () =>
          this.request(
            `/calls/${callControlIdPathSegment(id)}/actions/streaming_stop`,
            { method: 'POST', body: JSON.stringify({}) },
            IN_CALL_ACTION_TIMEOUT_MS,
          ),
        {
          attempts: IN_CALL_ACTION_RETRY_ATTEMPTS,
          isRetryable: err => err instanceof TelnyxRequestError && err.retryable,
        },
      );
    } catch (err) {
      if (err instanceof Error && isAlreadyInDesiredStateError(err.message)) {
        return; // Streaming already stopped (e.g. call already torn down) — nothing left to do.
      }
      throw err;
    }
  }

  /**
   * Cold-transfer the PSTN leg to another number or SIP URI.
   * `fromCallerId` must be a **Telnyx number or verified outbound caller ID** on the account;
   * do not pass the remote party's PSTN number or Telnyx returns "Unverified origination number".
   * Omit it to let Telnyx use the connection default.
   * Runs live on the call, so it gets the same short timeout / minimal-retry treatment as
   * `answerCall` / `startBidirectionalStream` — a stale retry here would re-issue a duplicate
   * transfer against a call that may have already moved.
   * @see https://developers.telnyx.com/api-reference/call-commands/transfer-call
   */
  async transferCall(callControlId: string, to: string, fromCallerId?: string): Promise<void> {
    const id = callControlId.startsWith('TLX_') ? callControlId.slice(4) : callControlId;
    const body: Record<string, unknown> = { to: to.trim() };
    if (fromCallerId !== undefined && fromCallerId.trim() !== '') {
      body.from = fromCallerId.trim();
    }
    await retryWithBackoff(
      () =>
        this.request(
          `/calls/${callControlIdPathSegment(id)}/actions/transfer`,
          { method: 'POST', body: JSON.stringify(body) },
          IN_CALL_ACTION_TIMEOUT_MS,
        ),
      {
        attempts: IN_CALL_ACTION_RETRY_ATTEMPTS,
        isRetryable: err => err instanceof TelnyxRequestError && err.retryable,
      },
    );
  }
}
