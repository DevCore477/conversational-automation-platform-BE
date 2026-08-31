export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Best-effort human-readable message from a Mozo API error response. Mozo's error shape
 * isn't fully documented (known codes like `invalid_client`, `app_not_available`,
 * `installation_not_found`), so this checks the common places a message could be
 * (`message`, `error` as a string, `error.message`) before falling back to the status code.
 */
export function extractMozoErrorMessage(json: unknown, status: number): string {
  if (isRecord(json)) {
    if (typeof json.message === 'string') {
      return json.message;
    }
    if (typeof json.error === 'string') {
      return json.error;
    }
    if (isRecord(json.error) && typeof json.error.message === 'string') {
      return json.error.message;
    }
  }
  return `HTTP ${String(status)}`;
}
