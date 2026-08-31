import { Injectable } from '@nestjs/common';

/**
 * Serializes async work per key so concurrent callers for the *same* key (e.g. a callSid) run
 * one at a time, in arrival order, instead of interleaving. Different keys never block each other.
 *
 * This exists because Telnyx can deliver webhook events for the same call concurrently (redelivery
 * on a slow ack, or overlapping events like `call.answered` and `call.hangup` landing back to back).
 * Without serialization, two handlers for the same call_control_id can race: both call the Telnyx
 * Call Control API at once (producing "already answered"/"already streaming" 500s), or a hangup can
 * be processed while a call.answered handler is still mid-flight and later overwrite its result.
 */
@Injectable()
export class KeyedAsyncLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();

    let releaseLock!: () => void;
    const lockPromise = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    // Whoever queues up next waits for us to finish (previousTail resolved/rejected, then our lock).
    const newTail = previousTail.then(
      () => lockPromise,
      () => lockPromise,
    );
    this.tails.set(key, newTail);

    // Wait our turn (a prior holder failing must not block us — only serialize, not propagate errors).
    await previousTail.catch(() => undefined);

    try {
      return await fn();
    } finally {
      releaseLock();
      if (this.tails.get(key) === newTail) {
        this.tails.delete(key);
      }
    }
  }
}
