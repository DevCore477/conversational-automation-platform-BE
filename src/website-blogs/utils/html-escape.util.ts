const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes admin-supplied text before it's embedded in the newsletter announcement HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
}
