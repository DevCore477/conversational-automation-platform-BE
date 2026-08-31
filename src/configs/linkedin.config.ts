import { registerAs } from '@nestjs/config';

/**
 * LinkedIn only supports the trailing ~12 months of versioned releases and rejects older
 * ones outright. A fixed default (e.g. '202401') silently goes stale and starts failing every
 * /rest/* call a year later with no code change — so instead of a fixed string, default to
 * "last month" (LinkedIn's monthly release lags the calendar slightly), which stays valid
 * indefinitely. Always prefer LINKEDIN_API_VERSION when explicitly set.
 */
function defaultLinkedInApiVersion(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${String(d.getUTCFullYear())}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default registerAs('linkedin', () => ({
  clientId: process.env.LINKEDIN_CLIENT_ID ?? '',
  clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? '',
  redirectUri: process.env.LINKEDIN_REDIRECT_URI ?? '',
  /**
   * Space-separated OAuth scopes requested during /linkedin/connect.
   * An org-admin scope (rw_organization_admin, or r_organization_admin on older API
   * generations — check the exact literal name under Developer Portal -> Auth tab) is
   * required to auto-discover which organization the connecting user administers (via
   * /rest/organizationAcls) since we don't ask for the org id upfront.
   * Both scopes need the "Community Management API" product approved on the LinkedIn app.
   */
  scopes: (process.env.LINKEDIN_SCOPES ?? 'r_organization_social rw_organization_admin')
    .split(/[\s,]+/)
    .filter(Boolean),
  /** LinkedIn versioned REST API (rest/posts). Format: YYYYMM. */
  apiVersion: process.env.LINKEDIN_API_VERSION ?? defaultLinkedInApiVersion(),
  apiBaseUrl: process.env.LINKEDIN_API_BASE_URL ?? 'https://api.linkedin.com',
  authBaseUrl: process.env.LINKEDIN_AUTH_BASE_URL ?? 'https://www.linkedin.com/oauth/v2',
  /** AES-256-GCM key used to encrypt stored access/refresh tokens (see token-crypto.util). */
  tokenEncryptionKey: process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY ?? '',
  /** Cron expression for the LinkedIn -> Blogs sync job. */
  syncCronExpression: process.env.LINKEDIN_SYNC_CRON ?? '*/30 * * * *',
  postsPageSize: Number(process.env.LINKEDIN_POSTS_PAGE_SIZE ?? 20) || 20,
  /** Safety cap on pages walked per organization per sync run. */
  maxPagesPerSync: Number(process.env.LINKEDIN_MAX_PAGES_PER_SYNC ?? 5) || 5,
  /** Hashtag (without '#') that marks a post as publishable; compared hyphen/underscore-insensitively. */
  publishHashtag: process.env.LINKEDIN_PUBLISH_HASHTAG ?? 'hexa-blog',
  /** Where the OAuth callback redirects the browser back to when done. */
  frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? process.env.APP_BASE_URL ?? '',
  maxRetries: Number(process.env.LINKEDIN_API_MAX_RETRIES ?? 3) || 3,
  retryBaseDelayMs: Number(process.env.LINKEDIN_API_RETRY_BASE_DELAY_MS ?? 1000) || 1000,
}));
