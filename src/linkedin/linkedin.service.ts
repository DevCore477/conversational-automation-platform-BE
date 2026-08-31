import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LinkedInApiClient, LinkedInApiError } from './linkedin-api.client';
import linkedinConfig from '../configs/linkedin.config';
import { decryptSecret, encryptSecret, maskToken } from '../common/utils/token-crypto.util';
import { LinkedInOrganization } from '../models/linkedin/linkedin-organization.entity';

/** Single global row — Hexa AI's own LinkedIn Company Page, not per-tenant. */
const ORG_ROW_ID = 'default';

/** Re-exchange this many seconds before expiry so sync calls never hit an expired token mid-run. */
const REFRESH_BEFORE_EXPIRY_SECONDS = 5 * 60;

interface OAuthState {
  userId: string;
  /** Typed as string (not the literal) since this is untrusted-shape JWT payload data at runtime. */
  purpose: string;
}

@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly apiClient: LinkedInApiClient,
    @InjectRepository(LinkedInOrganization)
    private readonly orgRepo: Repository<LinkedInOrganization>,
  ) {}

  private cfg() {
    return this.configService.getOrThrow<ConfigType<typeof linkedinConfig>>('linkedin');
  }

  private encryptionKey(): string {
    return this.cfg().tokenEncryptionKey;
  }

  /**
   * Step 1 of OAuth: build the LinkedIn authorization URL. `state` is a short-lived signed
   * JWT (not a DB row) so this stays stateless across multiple app instances — LinkedIn
   * echoes it back untouched on the callback, and we verify the signature there.
   */
  buildConnectUrl(userId: string): string {
    const cfg = this.cfg();
    if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
      throw new ServiceUnavailableException(
        'LinkedIn integration is not configured (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REDIRECT_URI)',
      );
    }

    const requiredAdminScopes = ['rw_organization_admin', 'r_organization_admin'];
    if (!cfg.scopes.some(s => requiredAdminScopes.includes(s))) {
      this.logger.warn(
        `LINKEDIN_SCOPES (${cfg.scopes.join(' ')}) has no organization-admin scope — ` +
          'organization discovery (GET /rest/organizationAcls) will fail after consent. ' +
          `Add one of: ${requiredAdminScopes.join(', ')} (check the exact name LinkedIn shows ` +
          'under Developer Portal -> Auth tab for this app).',
      );
    }

    const state = this.jwtService.sign({ userId, purpose: 'linkedin-oauth' } satisfies OAuthState, {
      expiresIn: '10m',
    });

    this.logger.log(`Starting LinkedIn OAuth for user ${userId}`);
    return this.apiClient.buildAuthorizationUrl(state);
  }

  /**
   * Step 2 of OAuth: verify state, exchange the code, and upsert the (single) organization row.
   * Returns the connected organization (never containing raw tokens).
   */
  async handleCallback(params: {
    code?: string;
    state: string;
    error?: string;
    errorDescription?: string;
  }): Promise<LinkedInOrganization> {
    this.logger.log(
      `LinkedIn callback received: hasCode=${String(!!params.code)} error=${params.error ?? '(none)'} ` +
        `errorDescription=${params.errorDescription ?? '(none)'}`,
    );

    if (params.error || !params.code) {
      this.logger.warn(
        `LinkedIn returned an OAuth error or no code: ${params.error ?? 'missing code'} — ${
          params.errorDescription ?? 'no description'
        }`,
      );
      throw new BadRequestException(
        params.errorDescription ?? params.error ?? 'LinkedIn authorization was not granted',
      );
    }

    let decoded: OAuthState;
    try {
      decoded = this.jwtService.verify<OAuthState>(params.state);
    } catch (err) {
      this.logger.warn(
        `LinkedIn callback state verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    if (decoded.purpose !== 'linkedin-oauth') {
      throw new BadRequestException('Invalid OAuth state');
    }
    this.logger.log(`OAuth state verified for user ${decoded.userId}; exchanging code for token`);

    const token = await this.apiClient.exchangeCodeForToken(params.code);
    const { organizationUrn, organizationId, organizationName } = await this.discoverOrganization(
      token.access_token,
    );
    const now = Date.now();

    const existing = await this.orgRepo.findOne({ where: { id: ORG_ROW_ID } });
    const key = this.encryptionKey();

    const entity = existing ?? this.orgRepo.create({ id: ORG_ROW_ID });
    entity.organizationUrn = organizationUrn;
    entity.organizationId = organizationId;
    entity.organizationName = organizationName;
    entity.accessTokenEncrypted = encryptSecret(token.access_token, key);
    entity.refreshTokenEncrypted = token.refresh_token
      ? encryptSecret(token.refresh_token, key)
      : null;
    entity.scope = token.scope ?? this.cfg().scopes.join(' ');
    entity.accessTokenExpiresAt = new Date(now + token.expires_in * 1000);
    entity.refreshTokenExpiresAt = token.refresh_token_expires_in
      ? new Date(now + token.refresh_token_expires_in * 1000)
      : null;
    entity.connectedByUserId = decoded.userId;
    entity.needsReconnect = false;
    entity.lastSyncError = null;
    entity.isActive = true;

    const saved = await this.orgRepo.save(entity);
    this.logger.log(`LinkedIn organization ${organizationUrn} connected`);
    return saved;
  }

  /**
   * Finds which organization the connecting member administers via /rest/organizationAcls —
   * no organizationId needs to be entered by hand. Requires r_organization_admin scope +
   * the Community Management API product to be approved on the LinkedIn app.
   */
  private async discoverOrganization(accessToken: string): Promise<{
    organizationUrn: string;
    organizationId: string;
    organizationName: string | null;
  }> {
    let acls: Awaited<ReturnType<LinkedInApiClient['fetchAdministeredOrganizations']>>;
    try {
      acls = await this.apiClient.fetchAdministeredOrganizations(accessToken);
    } catch (err) {
      if (err instanceof LinkedInApiError && (err.status === 401 || err.status === 403)) {
        this.logger.error(
          `organizationAcls request was rejected (${String(err.status)}) — this is almost always ` +
            'a missing/unapproved scope (rw_organization_admin / r_organization_admin) or the ' +
            `Community Management API product not being approved yet. Raw body: ${JSON.stringify(err.body)}`,
        );
        throw new BadRequestException(
          'LinkedIn rejected the organization lookup — the granted token is missing the ' +
            'organization-admin scope, or the "Community Management API" product is not yet ' +
            'approved for this app. Check Developer Portal -> Products and -> Auth -> OAuth 2.0 scopes.',
        );
      }
      throw err;
    }
    const urns = [
      ...new Set(
        acls
          .map(acl => acl.organizationalTarget ?? acl.organization)
          .filter((u): u is string => !!u),
      ),
    ];

    if (urns.length === 0) {
      throw new BadRequestException(
        'No LinkedIn organization found where this account is an administrator. Confirm you are a Page admin and that the app has the Community Management API product (r_organization_admin) approved.',
      );
    }
    if (urns.length > 1) {
      this.logger.warn(
        `Multiple administered LinkedIn organizations found; connecting the first: ${urns.join(', ')}`,
      );
    }

    const organizationUrn = urns[0];
    const organizationId = organizationUrn.split(':').pop() ?? organizationUrn;
    const organizationName = await this.apiClient.fetchOrganizationName(
      organizationId,
      accessToken,
    );

    return { organizationUrn, organizationId, organizationName };
  }

  async getOrganization(): Promise<LinkedInOrganization> {
    const org = await this.orgRepo.findOne({ where: { id: ORG_ROW_ID } });
    if (!org) {
      throw new NotFoundException('No LinkedIn organization connected yet');
    }
    return org;
  }

  /** Safe-to-expose view — access/refresh tokens are masked, never returned raw. */
  toPublicView(org: LinkedInOrganization) {
    return {
      organizationUrn: org.organizationUrn,
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      scope: org.scope,
      accessTokenExpiresAt: org.accessTokenExpiresAt,
      hasRefreshToken: !!org.refreshTokenEncrypted,
      accessTokenPreview: maskToken(decryptSecret(org.accessTokenEncrypted, this.encryptionKey())),
      lastSyncedAt: org.lastSyncedAt,
      needsReconnect: org.needsReconnect,
      lastSyncError: org.lastSyncError,
      isActive: org.isActive,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
    };
  }

  /** Returns a valid access token, refreshing (and persisting) it first if it's near expiry. */
  async getValidAccessToken(org: LinkedInOrganization): Promise<string> {
    const key = this.encryptionKey();
    const expiresInSeconds = (org.accessTokenExpiresAt.getTime() - Date.now()) / 1000;

    if (expiresInSeconds > REFRESH_BEFORE_EXPIRY_SECONDS) {
      return decryptSecret(org.accessTokenEncrypted, key);
    }

    if (!org.refreshTokenEncrypted) {
      org.needsReconnect = true;
      org.lastSyncError =
        'Access token expired and no refresh token is available; reconnect required.';
      await this.orgRepo.save(org);
      throw new ServiceUnavailableException(org.lastSyncError);
    }

    const refreshToken = decryptSecret(org.refreshTokenEncrypted, key);
    const token = await this.apiClient.refreshAccessToken(refreshToken);
    const now = Date.now();

    org.accessTokenEncrypted = encryptSecret(token.access_token, key);
    if (token.refresh_token) {
      org.refreshTokenEncrypted = encryptSecret(token.refresh_token, key);
    }
    org.accessTokenExpiresAt = new Date(now + token.expires_in * 1000);
    if (token.refresh_token_expires_in) {
      org.refreshTokenExpiresAt = new Date(now + token.refresh_token_expires_in * 1000);
    }
    org.needsReconnect = false;
    await this.orgRepo.save(org);

    this.logger.log(`Refreshed LinkedIn access token for organization ${org.organizationUrn}`);
    return token.access_token;
  }

  /** There is at most one active, reconnect-clean organization row. */
  async getActiveOrganization(): Promise<LinkedInOrganization | null> {
    return this.orgRepo.findOne({
      where: { id: ORG_ROW_ID, isActive: true, needsReconnect: false },
    });
  }

  async markSyncResult(org: LinkedInOrganization, error: string | null): Promise<void> {
    org.lastSyncedAt = new Date();
    org.lastSyncError = error;
    await this.orgRepo.save(org);
  }

  async markNeedsReconnect(org: LinkedInOrganization, reason: string): Promise<void> {
    org.needsReconnect = true;
    org.lastSyncError = reason;
    await this.orgRepo.save(org);
    this.logger.warn(`LinkedIn organization ${org.organizationUrn} needs reconnect: ${reason}`);
  }
}
