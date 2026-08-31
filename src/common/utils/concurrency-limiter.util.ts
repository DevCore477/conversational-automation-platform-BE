/**
 * Runs `fn` over every item with at most `limit` in flight at once — every item is fully
 * independent (one throwing never stops or delays the others, matching Promise.allSettled
 * semantics) and there is no artificial delay between items; throughput is bounded purely by
 * `limit`, not by a fixed sleep.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const boundedLimit = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await fn(items[index], index);
      } catch {
        // Each item's own errors are its caller's responsibility to handle/log — a single item
        // failing must never stop this worker from picking up the next one.
      }
    }
  }

  await Promise.all(Array.from({ length: boundedLimit }, () => worker()));
}
