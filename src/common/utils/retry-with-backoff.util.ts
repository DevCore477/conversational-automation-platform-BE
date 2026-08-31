/**
 * Generic exponential-backoff retry helper. Centralizes retry policy so transient failures
 * (network blips, 5xx, timeouts) get a bounded number of attempts with increasing delay + jitter,
 * instead of every call site rolling its own ad-hoc sleep loop with inconsistent behavior.
 */
export interface RetryOptions {
  /** Total attempts, including the first. Default: 3. */
  attempts?: number;
  /** Delay before the 2nd attempt. Doubles each subsequent attempt. Default: 300ms. */
  baseDelayMs?: number;
  /** Upper bound on any single delay. Default: 5000ms. */
  maxDelayMs?: number;
  /** Decide whether a given error should be retried. Default: always retry. */
  isRetryable?: (error: unknown) => boolean;
  /** Called before sleeping ahead of a retry (for logging). */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const isRetryable = options.isRetryable ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) {
        throw error;
      }
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = exp + Math.random() * exp * 0.3;
      options.onRetry?.(attempt, error, delayMs);
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable: loop either returns or throws on the final attempt.
  throw lastError;
}
