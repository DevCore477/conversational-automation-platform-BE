import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';

import linkedinConfig from '../configs/linkedin.config';

export class LinkedInApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'LinkedInApiError';
  }
}

export interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** A single image/video reference as it appears inside a post's `content` block. */
interface LinkedInMediaRef {
  id: string;
  title?: string;
  altText?: string;
}

/** Raw shape of an element from GET /rest/posts (LinkedIn Posts API). */
export interface LinkedInPostDto {
  id: string;
  author: string;
  commentary?: string;
  lifecycleState?: string;
  visibility?: string;
  createdAt?: number;
  publishedAt?: number;
  lastModifiedAt?: number;
  content?: {
    media?: LinkedInMediaRef;
    multiImage?: { images: LinkedInMediaRef[] };
    article?: { source: string; title?: string; thumbnail?: LinkedInMediaRef };
  };
  [key: string]: unknown;
}

/** Normalized, presentation-ready view of a post — resolved media URLs, URL, engagement. */
export interface LinkedInPostView {
  id: string;
  author: string;
  text: string | null;
  images: string[];
  videos: string[];
  articleUrl: string | null;
  publishedAt: Date | null;
  postUrl: string;
  engagement: { likes: number; comments: number; shares: number } | null;
}

export interface LinkedInPostsPage {
  elements: LinkedInPostDto[];
  paging: { start: number; count: number; total?: number };
}

/** One row from /rest/organizationAcls — a organization the authenticated member administers. */
export interface LinkedInOrganizationAcl {
  /** urn:li:organization:{id} — field name per LinkedIn's Organization ACL schema. */
  organizationalTarget?: string;
  /** Older API versions expose the same urn under this field name instead. */
  organization?: string;
  role?: string;
  state?: string;
}

/** Masks a secret for logs: keeps a short prefix/suffix, never the full value. */
function mask(value: string | undefined | null): string {
  if (!value) return '(empty)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)} (len ${String(value.length)})`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Thin wrapper around LinkedIn's OAuth 2.0 + versioned REST (Posts) APIs.
 * No scraping: every call here hits an official documented LinkedIn endpoint.
 */
@Injectable()
export class LinkedInApiClient implements OnModuleInit {
  private readonly logger = new Logger(LinkedInApiClient.name);

  constructor(private readonly configService: ConfigService) {}

  private cfg() {
    return this.configService.getOrThrow<ConfigType<typeof linkedinConfig>>('linkedin');
  }

  /**
   * LinkedIn drops support for a versioned release ~12 months after it ships. A version
   * pinned in config months ago (or via a forgotten LINKEDIN_API_VERSION override) fails
   * every /rest/* call with no obvious symptom other than "organization connection failed" —
   * so warn loudly at boot if the configured version looks older than that window.
   */
  onModuleInit(): void {
    const cfg = this.cfg();
    const match = /^(\d{4})(\d{2})$/.exec(cfg.apiVersion);
    if (!match) {
      this.logger.warn(`LINKEDIN_API_VERSION "${cfg.apiVersion}" is not in YYYYMM format`);
      return;
    }
    const versionDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    const ageMonths = (Date.now() - versionDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    if (ageMonths > 12) {
      this.logger.warn(
        `LINKEDIN_API_VERSION "${cfg.apiVersion}" is ~${String(Math.floor(ageMonths))} months old — ` +
          'LinkedIn typically only supports the trailing 12 months of versioned releases and will ' +
          'reject requests with this header. Update LINKEDIN_API_VERSION to a recent YYYYMM.',
      );
    }
    this.logger.log(
      `LinkedIn integration configured: apiVersion=${cfg.apiVersion}, scopes=[${cfg.scopes.join(', ')}], ` +
        `redirectUri=${cfg.redirectUri}, authBaseUrl=${cfg.authBaseUrl}, apiBaseUrl=${cfg.apiBaseUrl}`,
    );
  }

  buildAuthorizationUrl(state: string): string {
    const cfg = this.cfg();
    const url = new URL(`${cfg.authBaseUrl}/authorization`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', cfg.scopes.join(' '));
    this.logger.log(
      `Built LinkedIn authorization URL: response_type=code client_id=${cfg.clientId} ` +
        `redirect_uri=${cfg.redirectUri} scope="${cfg.scopes.join(' ')}" state=${mask(state)}`,
    );
    this.logger.debug(`Full authorization URL: ${url.toString()}`);
    return url.toString();
  }

  async exchangeCodeForToken(code: string): Promise<LinkedInTokenResponse> {
    const cfg = this.cfg();
    this.logger.log(
      `Exchanging authorization code for access token: grant_type=authorization_code ` +
        `redirect_uri=${cfg.redirectUri} client_id=${cfg.clientId} code=${mask(code)}`,
    );
    return this.postForm(`${cfg.authBaseUrl}/accessToken`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
  }

  async refreshAccessToken(refreshToken: string): Promise<LinkedInTokenResponse> {
    const cfg = this.cfg();
    this.logger.log(`Refreshing LinkedIn access token: refresh_token=${mask(refreshToken)}`);
    return this.postForm(`${cfg.authBaseUrl}/accessToken`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
  }

  private async postForm(
    url: string,
    params: Record<string, string>,
  ): Promise<LinkedInTokenResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as LinkedInTokenResponse & {
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !data.access_token) {
      this.logger.error(
        `LinkedIn token request failed: POST ${url} -> ${String(res.status)} ${res.statusText} ` +
          `body=${JSON.stringify(data)}`,
      );
      throw new LinkedInApiError(
        data.error_description ??
          data.error ??
          `LinkedIn token request failed (${String(res.status)})`,
        res.status,
        data,
      );
    }

    this.logger.log(
      `LinkedIn token request succeeded: POST ${url} -> ${String(res.status)} ` +
        `access_token=${mask(data.access_token)} expires_in=${String(data.expires_in)}s ` +
        `has_refresh_token=${String(!!data.refresh_token)} scope="${data.scope ?? ''}"`,
    );
    return data;
  }

  /**
   * GET /rest/posts?author={organizationUrn}&q=author — paginated, newest first.
   * Only ever queries by the organization's own URN, so personal posts can never surface.
   */
  async fetchOrganizationPosts(
    organizationUrn: string,
    accessToken: string,
    opts: { start?: number; count?: number } = {},
  ): Promise<LinkedInPostsPage> {
    const cfg = this.cfg();
    const url = new URL(`${cfg.apiBaseUrl}/rest/posts`);
    url.searchParams.set('author', organizationUrn);
    url.searchParams.set('q', 'author');
    url.searchParams.set('sortBy', 'LAST_MODIFIED');
    url.searchParams.set('start', String(opts.start ?? 0));
    url.searchParams.set('count', String(opts.count ?? cfg.postsPageSize));

    const data = await this.getWithRetry<{
      elements?: LinkedInPostDto[];
      paging?: { start: number; count: number; total?: number };
    }>(url.toString(), accessToken);

    const elements = data.elements ?? [];
    this.logger.log(
      `fetchOrganizationPosts(${organizationUrn}, start=${String(opts.start ?? 0)}): ` +
        `${String(elements.length)} post(s) returned`,
    );
    return { elements, paging: data.paging ?? { start: 0, count: 0 } };
  }

  /**
   * GET /rest/organizationAcls?q=roleAssignee — the organizations the connecting member
   * administers. This is how we discover organizationId without asking the admin to type it
   * in; requires the r_organization_admin scope + the Community Management API product.
   */
  async fetchAdministeredOrganizations(accessToken: string): Promise<LinkedInOrganizationAcl[]> {
    const cfg = this.cfg();
    const url = new URL(`${cfg.apiBaseUrl}/rest/organizationAcls`);
    url.searchParams.set('q', 'roleAssignee');
    url.searchParams.set('role', 'ADMINISTRATOR');
    url.searchParams.set('state', 'APPROVED');

    const data = await this.getWithRetry<{ elements?: LinkedInOrganizationAcl[] }>(
      url.toString(),
      accessToken,
    );
    const acls = data.elements ?? [];
    this.logger.log(`fetchAdministeredOrganizations: found ${String(acls.length)} ACL row(s)`);
    return acls;
  }

  /** Best-effort resolve of an `urn:li:image:{id}` to a temporary public downloadUrl. */
  private async fetchImageUrl(urn: string, accessToken: string): Promise<string | null> {
    const cfg = this.cfg();
    try {
      const data = await this.getWithRetry<{ downloadUrl?: string }>(
        `${cfg.apiBaseUrl}/rest/images/${encodeURIComponent(urn)}`,
        accessToken,
      );
      return data.downloadUrl ?? null;
    } catch (err) {
      this.logger.warn(`Could not resolve LinkedIn image ${urn}: ${errMsg(err)}`);
      return null;
    }
  }

  /** Best-effort resolve of an `urn:li:video:{id}` to a temporary public downloadUrl. */
  private async fetchVideoUrl(urn: string, accessToken: string): Promise<string | null> {
    const cfg = this.cfg();
    try {
      const data = await this.getWithRetry<{ downloadUrl?: string }>(
        `${cfg.apiBaseUrl}/rest/videos/${encodeURIComponent(urn)}`,
        accessToken,
      );
      return data.downloadUrl ?? null;
    } catch (err) {
      this.logger.warn(`Could not resolve LinkedIn video ${urn}: ${errMsg(err)}`);
      return null;
    }
  }

  /**
   * GET /rest/socialActions/{postUrn} — like/comment counts for one post. Best-effort:
   * older posts or restricted visibility can 404/403 here even though the post itself is
   * readable, so a failure here must never fail the whole sync.
   */
  private async fetchPostEngagement(
    postUrn: string,
    accessToken: string,
  ): Promise<{ likes: number; comments: number; shares: number } | null> {
    const cfg = this.cfg();
    try {
      const data = await this.getWithRetry<{
        likesSummary?: { totalLikes?: number };
        commentsSummary?: { totalFirstLevelComments?: number };
      }>(`${cfg.apiBaseUrl}/rest/socialActions/${encodeURIComponent(postUrn)}`, accessToken);
      return {
        likes: data.likesSummary?.totalLikes ?? 0,
        comments: data.commentsSummary?.totalFirstLevelComments ?? 0,
        shares: 0,
      };
    } catch (err) {
      this.logger.warn(`Could not fetch engagement for ${postUrn}: ${errMsg(err)}`);
      return null;
    }
  }

  /** Canonical public URL for an organization post — LinkedIn's Posts API returns no URL field. */
  private buildPostUrl(postUrn: string): string {
    return `https://www.linkedin.com/feed/update/${postUrn}/`;
  }

  /**
   * Resolves a raw Posts API element into a presentation-ready view: text, resolved image/video
   * URLs, article link, post URL, and best-effort engagement counts.
   */
  async toPostView(post: LinkedInPostDto, accessToken: string): Promise<LinkedInPostView> {
    const imageRefs = [
      ...(post.content?.media?.id ? [post.content.media] : []),
      ...(post.content?.multiImage?.images ?? []),
    ];
    const isVideo = (id: string) =>
      id.includes(':video:') || id.includes(':digitalmediaAsset:video');

    const [images, videos, engagement] = await Promise.all([
      Promise.all(
        imageRefs
          .filter(ref => !isVideo(ref.id))
          .map(ref => this.fetchImageUrl(ref.id, accessToken)),
      ),
      Promise.all(
        imageRefs
          .filter(ref => isVideo(ref.id))
          .map(ref => this.fetchVideoUrl(ref.id, accessToken)),
      ),
      this.fetchPostEngagement(post.id, accessToken),
    ]);

    const publishedAtMs = post.publishedAt ?? post.createdAt;
    return {
      id: post.id,
      author: post.author,
      text: post.commentary ?? null,
      images: images.filter((u): u is string => !!u),
      videos: videos.filter((u): u is string => !!u),
      articleUrl: post.content?.article?.source ?? null,
      publishedAt: publishedAtMs ? new Date(publishedAtMs) : null,
      postUrl: this.buildPostUrl(post.id),
      engagement,
    };
  }

  /** GET /rest/organizations/{id} — best-effort display name lookup; failures are non-fatal. */
  async fetchOrganizationName(organizationId: string, accessToken: string): Promise<string | null> {
    const cfg = this.cfg();
    const url = `${cfg.apiBaseUrl}/rest/organizations/${organizationId}`;
    try {
      const data = await this.getWithRetry<{ localizedName?: string }>(url, accessToken);
      return data.localizedName ?? null;
    } catch (err) {
      this.logger.warn(
        `Could not fetch LinkedIn organization name for ${organizationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** GET with exponential backoff on 429/5xx, honoring Retry-After when LinkedIn sends it. */
  private async getWithRetry<T>(url: string, accessToken: string): Promise<T> {
    const cfg = this.cfg();
    let attempt = 0;

    for (;;) {
      this.logger.debug(
        `LinkedIn API GET ${url} (LinkedIn-Version=${cfg.apiVersion}, token=${mask(accessToken)}, attempt=${String(attempt + 1)})`,
      );
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': cfg.apiVersion,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      });

      if (res.ok) {
        this.logger.debug(`LinkedIn API GET ${url} -> ${String(res.status)}`);
        return (await res.json()) as T;
      }

      const retryable = res.status === 429 || res.status >= 500;
      attempt += 1;

      if (!retryable || attempt > cfg.maxRetries) {
        const body: unknown = await res.json().catch(() => undefined);
        this.logger.error(
          `LinkedIn API error: GET ${url} -> ${String(res.status)} ${res.statusText} ` +
            `body=${JSON.stringify(body)}`,
        );
        throw new LinkedInApiError(
          `LinkedIn API error ${String(res.status)} for ${url}`,
          res.status,
          body,
        );
      }

      const retryAfterHeader = Number(res.headers.get('retry-after'));
      const delayMs =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : cfg.retryBaseDelayMs * 2 ** (attempt - 1);

      this.logger.warn(
        `LinkedIn API ${String(res.status)} (attempt ${String(attempt)}/${String(cfg.maxRetries)}), retrying in ${String(delayMs)}ms`,
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
