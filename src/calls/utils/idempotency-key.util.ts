import { BadRequestException } from '@nestjs/common';

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Builds the BullMQ jobId used for an idempotent `POST /calls` request: `idem:<scope>:<key>`.
 *
 * The scope prefix is required, not cosmetic — the underlying jobId is a single global namespace
 * shared by every caller of the outbound queue, so without it, company A's client reusing the
 * idempotency key "retry-1" would silently attach to (and could overwrite the target number of)
 * company B's job if B happened to use the same string. Scoping by company (or, for unauthenticated
 * trusted-origin callers, by their attributed identity) makes collisions require the same identity
 * AND the same key, which is the actual idempotency guarantee callers expect.
 *
 * Returns undefined (caller falls back to a random UUID) when there is no reliable identity to
 * scope by — an anonymous caller's idempotency key can't be safely bound to anything, but that
 * path is already tightly rate-limited (see MakeCallRateLimitGuard), so silently skipping
 * idempotency there is a low-stakes, acceptable trade rather than a reason to reject the request.
 *
 * Colons in the raw key are rejected (not stripped) — BullMQ's own jobId validation only allows a
 * colon-containing custom id when it splits into exactly 3 segments (reserved for repeatable job
 * ids); silently stripping could coalesce two keys a caller intended to be distinct.
 */
export function buildIdempotencyJobId(
  rawKey: string | undefined,
  scope: string | undefined,
): string | undefined {
  if (rawKey == null || rawKey.trim() === '') return undefined;
  const key = rawKey.trim();

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestException(
      `Idempotency-Key must be ${String(MAX_IDEMPOTENCY_KEY_LENGTH)} characters or fewer`,
    );
  }
  if (key.includes(':')) {
    throw new BadRequestException("Idempotency-Key must not contain ':'");
  }
  if (!scope) return undefined;

  return `idem:${scope}:${key}`;
}
