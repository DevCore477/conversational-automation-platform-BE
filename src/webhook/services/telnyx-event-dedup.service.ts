import { Injectable } from '@nestjs/common';

/**
 * De-duplicates Telnyx Call Control webhook events by their `data.id`. Telnyx delivers "at least
 * once" — a slow-to-ack endpoint or a network blip on Telnyx's side causes the *same* event to be
 * POSTed again. Without this, a redelivered `call.answered` can race the first delivery and issue a
 * second `streaming_start` on the same leg (Telnyx call-control 500s on the conflicting command),
 * or a redelivered `call.hangup` can re-run status/metadata updates redundantly.
 *
 * Only successful outcomes are remembered: an event that failed is deliberately left eligible for
 * reprocessing, so a genuine Telnyx redelivery after a transient failure can still succeed.
 */
@Injectable()
export class TelnyxEventDedupService {
  private readonly succeeded = new Map<string, number>();
  private readonly ttlMs = 30 * 60 * 1000; // Well beyond Telnyx's webhook redelivery window.

  isDuplicate(eventId: string): boolean {
    this.evictExpired();
    return this.succeeded.has(eventId);
  }

  markSucceeded(eventId: string): void {
    this.succeeded.set(eventId, Date.now());
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, at] of this.succeeded) {
      if (at < cutoff) this.succeeded.delete(id);
    }
  }
}
