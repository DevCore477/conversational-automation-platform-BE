const HASHTAG_RE = /#([\p{L}\p{N}_-]+)/gu;

export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const tags = new Set<string>();
  for (const match of text.matchAll(HASHTAG_RE)) {
    tags.add(match[1]);
  }
  return [...tags];
}

/** Hyphen/underscore/case-insensitive match, e.g. "#hexa-blog" === "#hexa_blog" === "#HexaBlog". */
export function normalizeHashtag(tag: string): string {
  return tag.toLowerCase().replace(/[-_]/g, '');
}

export function isPublishableByHashtags(hashtags: string[], publishHashtag: string): boolean {
  const target = normalizeHashtag(publishHashtag);
  return hashtags.some(tag => normalizeHashtag(tag) === target);
}

export function deriveTitle(commentary: string | null | undefined, fallback: string): string {
  const stripped = (commentary ?? '').replace(HASHTAG_RE, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return fallback;
  const firstLine = stripped.split(/\n/)[0].trim() || stripped;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117).trimEnd()}...` : firstLine;
}

export function deriveExcerpt(commentary: string | null | undefined): string | null {
  const stripped = (commentary ?? '').replace(HASHTAG_RE, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return null;
  return stripped.length > 280 ? `${stripped.slice(0, 277).trimEnd()}...` : stripped;
}

/**
 * Slug is derived from the title plus a short suffix of the post URN so near-identical
 * post openings never collide — this stays stable across re-runs for the same post.
 */
export function slugify(title: string, postUrn: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
  const suffix = postUrn.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  return `${base || 'linkedin-post'}-${suffix}`;
}
