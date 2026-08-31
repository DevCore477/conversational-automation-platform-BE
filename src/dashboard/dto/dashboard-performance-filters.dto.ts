/**
 * Optional query parameters for dashboard performance endpoints (`agents`, `flows`, `scripts`).
 * Responses include `{ agents|flows|scripts, usage }` where `usage` is time-bucketed like `calls/volume/by-resource`.
 *
 * Without `from`, `to`, or `period`, the window defaults to **last 24 hours** (`day`-style buckets).
 * Use sliding `period` ending at server "now", or explicit `from` / `to` (ISO 8601).
 * When `period` is omitted but `from`/`to` are set, bucket layout defaults to `day`.
 */
export type DashboardPerformancePeriod = 'hour' | 'day' | 'week' | 'month';

export interface DashboardPerformanceFilters {
  /** Inclusive start (ISO 8601). With only `from`, `to` defaults to now. */
  from?: string;
  /** Inclusive end (ISO 8601). */
  to?: string;
  /** Sliding window ending at now; ignored if `from` or `to` is provided. */
  period?: DashboardPerformancePeriod;
  /** Restrict agent performance to this agent (UUID). */
  agentId?: string;
  /** Restrict flow performance to this flow (UUID). */
  flowId?: string;
  /** Restrict script performance to this script (UUID). */
  scriptId?: string;
}
