/**
 * Races a promise against a timeout. Needed anywhere a Redis command can be issued against a
 * BullMQ-managed connection: BullMQ requires `maxRetriesPerRequest: null` (Worker won't start
 * without it), which means ioredis queues a command and retries the underlying connection
 * INDEFINITELY rather than ever rejecting — a command issued while Redis is unreachable never
 * resolves AND never throws. Without this wrapper, "fail safely / fail open" catch blocks around
 * such a command are dead code: the call hangs forever before ever reaching the catch.
 *
 * Note: this does not cancel the underlying command — ioredis has no cancellation API — so on
 * timeout the real command may still complete later in the background after this has already
 * moved on. That's an acceptable tradeoff versus hanging the caller (e.g. an HTTP request)
 * indefinitely.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
