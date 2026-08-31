import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import whatsappConfig from '../../configs/whatsapp.config';
import { MetaWhatsAppApiError } from './meta-whatsapp.client';
import { WhatsAppMetaToken } from '../../models/whatsapp/whatsapp-meta-token.entity';

const TOKEN_ROW_ID = 'default';

const MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Re-exchange when this many seconds remain (safety margin before Meta rejects API calls) */
const EXCHANGE_BEFORE_EXPIRY_SECONDS = 30 * 60;

const INSPECT_CACHE_MS = 15 * 1000;

const AUTH_ERROR_CODES = new Set([190, 102, 463, 467]);

interface ExchangeTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string; code?: number; type?: string };
}

export interface MetaTokenStatus {
  tokenSuffix: string;
  isValid: boolean;
  expiresAt: string | null;
  issuedAt: string | null;
  expiresInSeconds: number | null;
  expiresInHours: number | null;
  expiresInDays: number | null;
  expirySummary: string | null;
  lifetimeSeconds: number | null;
  isPermanent: boolean;
  tokenType: string | null;
  dbExpiresAt: string | null;
  updatedAt: string | null;
  shouldRefreshSoon: boolean;
  source: 'env' | 'database';
  syncedToDb: boolean;
  envTokenInUse: boolean;
}

interface DebugTokenInfo {
  isValid: boolean;
  expiresAt: Date | null;
  issuedAt: Date | null;
  isPermanent: boolean;
  tokenType: string | null;
  /** True when expiry is unknown (debug_token skipped or failed on app credentials). */
  expiryUnknown?: boolean;
}

interface DebugTokenApiResult {
  ok: boolean;
  info: DebugTokenInfo;
  appCredentialError?: boolean;
  errorMessage?: string;
}

interface ResolvedToken {
  token: string;
  info: DebugTokenInfo;
  source: 'env' | 'database';
}

@Injectable()
export class MetaTokenService implements OnModuleInit {
  private readonly logger = new Logger(MetaTokenService.name);
  private refreshPromise: Promise<string> | null = null;
  private inspectCache: { token: string; info: DebugTokenInfo; at: number } | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(WhatsAppMetaToken)
    private readonly tokenRepo: Repository<WhatsAppMetaToken>,
  ) {}

  async onModuleInit(): Promise<void> {
    const envToken = this.getEnvToken();
    if (!envToken) {
      return;
    }
    const cfg = this.getCfg();
    if (!cfg?.metaAppId || !cfg?.metaAppSecret) {
      this.logger.warn(
        'WHATSAPP_META_APP_ID + WHATSAPP_META_APP_SECRET required for automatic token refresh. ' +
          'Without them the DB cache cannot exchange tokens and they will expire.',
      );
      const info = await this.inspectToken(envToken);
      await this.persistToken(envToken, info.expiresAt);
      return;
    }

    try {
      await this.bootstrapToken();
    } catch (err) {
      this.logger.error(`Meta token bootstrap failed: ${(err as Error).message}`);
    }
  }

  @Interval(MAINTENANCE_INTERVAL_MS)
  async scheduledMaintenance(): Promise<void> {
    const cfg = this.getCfg();
    if (!cfg?.metaAppId || !cfg?.metaAppSecret) {
      return;
    }
    try {
      await this.runMaintenanceCycle('scheduled');
    } catch (err) {
      this.logger.warn(`Scheduled Meta token maintenance failed: ${(err as Error).message}`);
    }
  }

  getCfg() {
    return this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
  }

  static isAuthError(error: unknown): boolean {
    if (error instanceof MetaWhatsAppApiError) {
      if (error.code != null && AUTH_ERROR_CODES.has(error.code)) {
        return true;
      }
      return /expired|invalid.*token|session.*invalid|oauth/i.test(error.message);
    }
    return false;
  }

  /**
   * Always reads process.env first so a newly deployed WHATSAPP_META_ACCESS_TOKEN is picked up
   * without relying on Nest config cached at startup.
   */
  getEnvToken(): string | null {
    const fromProcess = process.env.WHATSAPP_META_ACCESS_TOKEN?.trim();
    if (fromProcess) {
      return fromProcess;
    }
    return this.getCfg()?.metaAccessToken?.trim() || null;
  }

  async getValidToken(): Promise<string> {
    const resolved = await this.resolveActiveToken();
    if (!resolved) {
      throw new ServiceUnavailableException(
        'No valid Meta access token. Set WHATSAPP_META_ACCESS_TOKEN to a fresh token from Meta Dashboard.',
      );
    }

    let { token, info } = resolved;

    if (!info.isValid) {
      return this.recoverFromAuthFailure();
    }

    if (!info.isPermanent && this.mustExchangeNow(info)) {
      token = await this.exchangeWhileValid(token, 'getValidToken');
      info = await this.inspectToken(token);
      await this.persistToken(token, info.expiresAt);
      this.inspectCache = { token, info, at: Date.now() };
    }

    if (!info.isValid) {
      throw new ServiceUnavailableException(
        'Meta access token is invalid after refresh. Paste a new token in WHATSAPP_META_ACCESS_TOKEN and restart, or POST /whatsapp/admin/meta-token/sync-env-token',
      );
    }

    return token;
  }

  /** Called when Graph API returns token expired / OAuth errors. */
  async recoverFromAuthFailure(): Promise<string> {
    this.inspectCache = null;
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.runMaintenanceCycle('auth-recovery').finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async refreshToken(force: boolean): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.runMaintenanceCycle(force ? 'force' : 'refresh').finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async forceSyncFromEnv(): Promise<string> {
    const envToken = this.getEnvToken();
    if (!envToken) {
      throw new ServiceUnavailableException('WHATSAPP_META_ACCESS_TOKEN is not set');
    }

    this.inspectCache = null;
    const info = await this.inspectToken(envToken);
    if (!info.isValid) {
      throw new ServiceUnavailableException(
        'WHATSAPP_META_ACCESS_TOKEN is invalid or expired. Generate a new token in Meta Dashboard.',
      );
    }

    await this.persistToken(envToken, info.expiresAt);

    const cfg = this.getCfg();
    if (cfg?.metaAppId && cfg?.metaAppSecret) {
      return this.exchangeWhileValid(envToken, 'forceSyncFromEnv');
    }

    return envToken;
  }

  async fetchExpiryAndSyncDb(): Promise<MetaTokenStatus> {
    return this.getTokenStatus(true);
  }

  async getTokenStatus(syncDb = true): Promise<MetaTokenStatus> {
    const row = await this.loadRow();
    const envToken = this.getEnvToken();
    const resolved = await this.resolveActiveToken();
    const token = resolved?.token ?? row?.accessToken ?? envToken ?? '';
    const dbExpiresAt = row?.expiresAt?.toISOString() ?? null;

    if (!token) {
      return this.emptyStatus(row);
    }

    const info = resolved?.info ?? (await this.inspectToken(token));
    if (syncDb) {
      await this.persistToken(token, info.expiresAt);
    }

    const expiresInSeconds = this.secondsUntil(info.expiresAt);

    return {
      tokenSuffix: token.slice(-8),
      isValid: info.isValid,
      expiresAt: info.expiresAt?.toISOString() ?? null,
      issuedAt: info.issuedAt?.toISOString() ?? null,
      expiresInSeconds,
      expiresInHours:
        expiresInSeconds != null ? Math.round((expiresInSeconds / 3600) * 100) / 100 : null,
      expiresInDays:
        expiresInSeconds != null
          ? Math.round((expiresInSeconds / 86400) * 10) / 10
          : null,
      expirySummary: this.formatExpirySummary(info.expiresAt, expiresInSeconds),
      lifetimeSeconds: this.lifetimeSeconds(info),
      isPermanent: info.isPermanent,
      tokenType: info.tokenType,
      dbExpiresAt,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      shouldRefreshSoon: this.mustExchangeNow(info),
      source: resolved?.source ?? 'database',
      syncedToDb: syncDb,
      envTokenInUse: resolved?.source === 'env',
    };
  }

  private emptyStatus(row: WhatsAppMetaToken | null): MetaTokenStatus {
    return {
      tokenSuffix: '',
      isValid: false,
      expiresAt: null,
      issuedAt: null,
      expiresInSeconds: null,
      expiresInHours: null,
      expiresInDays: null,
      expirySummary: null,
      lifetimeSeconds: null,
      isPermanent: false,
      tokenType: null,
      dbExpiresAt: row?.expiresAt?.toISOString() ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      shouldRefreshSoon: true,
      source: 'database',
      syncedToDb: false,
      envTokenInUse: false,
    };
  }

  private async bootstrapToken(): Promise<void> {
    const token = await this.runMaintenanceCycle('bootstrap');
    const info = await this.inspectToken(token);
    const secs = this.secondsUntil(info.expiresAt);
    this.logger.log(
      `Meta WhatsApp token ready (…${token.slice(-8)}): ${this.formatExpirySummary(info.expiresAt, secs)}`,
    );
  }

  /**
   * Pick the best token: valid env beats invalid DB; newer env beats stale DB; longest-lived wins.
   */
  private async resolveActiveToken(): Promise<ResolvedToken | null> {
    const envToken = this.getEnvToken();
    const row = await this.loadRow();
    const dbToken = row?.accessToken?.trim() || null;

    const envInfo = envToken ? await this.inspectToken(envToken) : null;
    const dbInfo = dbToken ? await this.inspectToken(dbToken) : null;

    const candidates: ResolvedToken[] = [];

    if (envToken && envInfo?.isValid) {
      candidates.push({ token: envToken, info: envInfo, source: 'env' });
    }
    if (dbToken && dbInfo?.isValid) {
      candidates.push({ token: dbToken, info: dbInfo, source: 'database' });
    }

    if (candidates.length === 0) {
      if (envToken && envInfo) {
        return { token: envToken, info: envInfo, source: 'env' };
      }
      if (dbToken && dbInfo) {
        return { token: dbToken, info: dbInfo, source: 'database' };
      }
      return null;
    }

    candidates.sort((a, b) => this.remainingMs(b.info) - this.remainingMs(a.info));
    const best = candidates[0];

    const envWins =
      envToken &&
      envInfo?.isValid &&
      (envToken !== dbToken || !dbInfo?.isValid || best.source === 'env');

    if (envWins && envToken && envInfo) {
      if (envToken !== dbToken) {
        this.logger.log(
          `Meta token: switched to WHATSAPP_META_ACCESS_TOKEN from env (…${envToken.slice(-8)})`,
        );
      }
      await this.persistToken(envToken, envInfo.expiresAt);
      return { token: envToken, info: envInfo, source: 'env' };
    }

    if (dbToken && dbInfo) {
      await this.persistToken(dbToken, dbInfo.expiresAt);
      return { token: dbToken, info: dbInfo, source: 'database' };
    }

    return best;
  }

  private remainingMs(info: DebugTokenInfo): number {
    if (info.isPermanent) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (!info.expiresAt) {
      return 0;
    }
    return info.expiresAt.getTime() - Date.now();
  }

  private async runMaintenanceCycle(trigger: string): Promise<string> {
    const cfg = this.getCfg();
    if (!cfg?.metaAppId || !cfg?.metaAppSecret) {
      const env = this.getEnvToken();
      if (!env) {
        throw new ServiceUnavailableException('WHATSAPP_META_ACCESS_TOKEN is not set');
      }
      const info = await this.inspectToken(env);
      await this.persistToken(env, info.expiresAt);
      return env;
    }

    this.inspectCache = null;

    const resolved = await this.resolveActiveToken();
    if (!resolved) {
      throw new ServiceUnavailableException(
        'No Meta access token in DB or env. Set WHATSAPP_META_ACCESS_TOKEN.',
      );
    }

    let { token, info } = resolved;

    if (!info.isValid) {
      throw new ServiceUnavailableException(
        'Meta access token is invalid or expired. Paste a new token in WHATSAPP_META_ACCESS_TOKEN (then restart or POST /whatsapp/admin/meta-token/sync-env-token).',
      );
    }

    await this.persistToken(token, info.expiresAt);
    this.inspectCache = { token, info, at: Date.now() };

    if (info.isPermanent || info.expiryUnknown) {
      this.logger.debug(
        `Meta token maintenance (${trigger}): ${info.expiryUnknown ? 'valid (expiry unknown — fix APP_ID/SECRET for debug_token)' : 'permanent token'}`,
      );
      return token;
    }

    const mustExchange =
      this.mustExchangeNow(info) ||
      trigger === 'force' ||
      trigger === 'auth-recovery' ||
      trigger === 'bootstrap';

    if (mustExchange) {
      token = await this.exchangeWhileValid(token, trigger);
      info = await this.inspectToken(token);
      await this.persistToken(token, info.expiresAt);
      this.inspectCache = { token, info, at: Date.now() };
      const secs = this.secondsUntil(info.expiresAt);
      this.logger.log(
        `Meta token maintenance (${trigger}): exchanged — ${this.formatExpirySummary(info.expiresAt, secs)}`,
      );
      return token;
    }

    const secs = this.secondsUntil(info.expiresAt);
    this.logger.debug(
      `Meta token maintenance (${trigger}): ${this.formatExpirySummary(info.expiresAt, secs)}`,
    );
    return token;
  }

  /** Exchange before expiry — includes a fixed safety window so API calls do not hit expired tokens. */
  private mustExchangeNow(info: DebugTokenInfo): boolean {
    if (info.expiryUnknown) {
      return false;
    }
    if (info.isPermanent) {
      return false;
    }
    if (!info.expiresAt) {
      return true;
    }

    const remainingSec = this.secondsUntil(info.expiresAt);
    if (remainingSec == null || remainingSec <= 0) {
      return false;
    }

    if (remainingSec <= EXCHANGE_BEFORE_EXPIRY_SECONDS) {
      return true;
    }

    const remainingMs = remainingSec * 1000;
    const lifetimeMs = this.lifetimeMs(info) ?? this.estimateLifetimeMs(remainingMs);

    if (lifetimeMs < 6 * 60 * 60 * 1000) {
      return remainingMs <= Math.max(20 * 60 * 1000, lifetimeMs * 0.5);
    }
    if (lifetimeMs < 7 * 24 * 60 * 60 * 1000) {
      return remainingMs <= Math.max(2 * 60 * 60 * 1000, lifetimeMs * 0.35);
    }
    return remainingMs <= Math.max(24 * 60 * 60 * 1000, lifetimeMs * 0.2);
  }

  private lifetimeMs(info: DebugTokenInfo): number | null {
    if (!info.expiresAt || !info.issuedAt) {
      return null;
    }
    const ms = info.expiresAt.getTime() - info.issuedAt.getTime();
    return ms > 0 ? ms : null;
  }

  private estimateLifetimeMs(remainingMs: number): number {
    if (remainingMs < 6 * 60 * 60 * 1000) {
      return 2 * 60 * 60 * 1000;
    }
    if (remainingMs < 7 * 24 * 60 * 60 * 1000) {
      return 24 * 60 * 60 * 1000;
    }
    return 60 * 24 * 60 * 60 * 1000;
  }

  private lifetimeSeconds(info: DebugTokenInfo): number | null {
    const ms = this.lifetimeMs(info);
    return ms != null ? Math.round(ms / 1000) : null;
  }

  private secondsUntil(expiresAt: Date | null): number | null {
    if (!expiresAt) {
      return null;
    }
    return Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
  }

  private formatExpirySummary(
    expiresAt: Date | null,
    secondsRemaining: number | null,
  ): string {
    if (!expiresAt) {
      return 'no expiry date (permanent or unknown)';
    }
    const when = this.formatExpiryDateUtc(expiresAt);
    if (secondsRemaining == null) {
      return `valid until ${when}`;
    }
    if (secondsRemaining <= 0) {
      return `EXPIRED (was ${when})`;
    }
    const days = Math.floor(secondsRemaining / 86400);
    const hours = Math.floor((secondsRemaining % 86400) / 3600);
    const remaining =
      days >= 1 ? `${days} days ${hours}h remaining` : `${Math.max(1, hours)}h remaining`;
    return `${remaining} — valid until ${when}`;
  }

  private formatExpiryDateUtc(d: Date): string {
    return (
      d.toLocaleString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }) + ' UTC'
    );
  }

  private async inspectTokenCached(token: string): Promise<DebugTokenInfo> {
    const cached = this.inspectCache;
    const remaining = cached?.info.expiresAt
      ? cached.info.expiresAt.getTime() - Date.now()
      : null;
    const nearExpiry = remaining != null && remaining < 60 * 60 * 1000;
    if (
      cached?.token === token &&
      !nearExpiry &&
      Date.now() - cached.at < INSPECT_CACHE_MS
    ) {
      return cached.info;
    }
    return this.inspectToken(token);
  }

  private async exchangeWhileValid(token: string, reason: string): Promise<string> {
    const cfg = this.getCfg();
    const appId = cfg?.metaAppId;
    const appSecret = cfg?.metaAppSecret;
    const apiVersion = cfg?.metaApiVersion ?? 'v25.0';

    if (!appId || !appSecret) {
      throw new ServiceUnavailableException(
        'WHATSAPP_META_APP_ID and WHATSAPP_META_APP_SECRET are required for token exchange',
      );
    }

    const info = await this.inspectToken(token);
    if (!info.isValid) {
      const env = this.getEnvToken();
      if (env && env !== token) {
        const envInfo = await this.inspectToken(env);
        if (envInfo.isValid) {
          this.logger.warn(
            `Meta token exchange (${reason}): DB token invalid, retrying with env token`,
          );
          return this.exchangeWhileValid(env, `${reason}-env-fallback`);
        }
      }
      throw new ServiceUnavailableException(
        `Cannot exchange: token is already invalid/expired (${reason}). Paste a new WHATSAPP_META_ACCESS_TOKEN from Meta Dashboard.`,
      );
    }

    const url = new URL(`https://graph.facebook.com/${apiVersion}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('fb_exchange_token', token);

    const res = await fetch(url.toString());
    const data = (await res.json()) as ExchangeTokenResponse;

    if (!res.ok || !data.access_token || data.error) {
      throw new Error(data.error?.message ?? 'Token exchange failed');
    }

    const verified = await this.inspectToken(data.access_token);
    const expiresAt =
      verified.expiresAt ??
      (data.expires_in != null ? new Date(Date.now() + data.expires_in * 1000) : null);

    await this.persistToken(data.access_token, expiresAt);
    this.inspectCache = { token: data.access_token, info: verified, at: Date.now() };

    const secs = this.secondsUntil(expiresAt);
    this.logger.log(
      `Meta token exchanged (${reason}): ${this.formatExpirySummary(expiresAt, secs)}`,
    );

    return data.access_token;
  }

  private async persistToken(accessToken: string, expiresAt: Date | null): Promise<void> {
    let row = await this.loadRow();
    if (!row) {
      row = this.tokenRepo.create({ id: TOKEN_ROW_ID, accessToken, expiresAt });
    } else {
      row.accessToken = accessToken;
      row.expiresAt = expiresAt;
    }
    await this.tokenRepo.save(row);
  }

  private async loadRow(): Promise<WhatsAppMetaToken | null> {
    return this.tokenRepo.findOne({ where: { id: TOKEN_ROW_ID } });
  }

  private async inspectToken(token: string): Promise<DebugTokenInfo> {
    const cfg = this.getCfg();
    const appId = cfg?.metaAppId?.trim();
    const appSecret = cfg?.metaAppSecret?.trim();
    const apiVersion = cfg?.metaApiVersion ?? 'v25.0';
    const phoneNumberId = cfg?.metaPhoneNumberId?.trim();

    if (appId && phoneNumberId && appId === phoneNumberId) {
      this.logger.warn(
        'WHATSAPP_APP_ID matches WHATSAPP_META_PHONE_NUMBER_ID — App ID must be the Facebook App ID from App Dashboard → Settings → Basic, not the phone number ID.',
      );
    }

    if (!appId || !appSecret) {
      const probed = await this.probeTokenWithGraph(token, apiVersion, phoneNumberId);
      if (probed) {
        return probed;
      }
      return {
        isValid: true,
        expiresAt: null,
        issuedAt: null,
        isPermanent: false,
        tokenType: null,
        expiryUnknown: true,
      };
    }

    const debug = await this.fetchDebugToken(token, appId, appSecret, apiVersion);
    if (debug.ok) {
      return debug.info;
    }

    if (debug.appCredentialError) {
      this.logger.warn(
        `Meta debug_token failed (${debug.errorMessage ?? 'app credentials'}). ` +
          'This usually means WHATSAPP_APP_ID / WHATSAPP_META_APP_SECRET are wrong or from a different app than your access token. ' +
          'Verifying WHATSAPP_META_ACCESS_TOKEN directly via Graph API.',
      );
      const probed = await this.probeTokenWithGraph(token, apiVersion, phoneNumberId);
      if (probed?.isValid) {
        return probed;
      }
    }

    return debug.info;
  }

  /**
   * Meta debug_token — requires a valid app access token (app_id|app_secret), not the user token.
   */
  private async fetchDebugToken(
    inputToken: string,
    appId: string,
    appSecret: string,
    apiVersion: string,
  ): Promise<DebugTokenApiResult> {
    const invalid: DebugTokenInfo = {
      isValid: false,
      expiresAt: null,
      issuedAt: null,
      isPermanent: false,
      tokenType: null,
    };

    try {
      const url = new URL(`https://graph.facebook.com/${apiVersion}/debug_token`);
      url.searchParams.set('input_token', inputToken);
      url.searchParams.set('access_token', `${appId}|${appSecret}`);

      const res = await fetch(url.toString());
      const data = (await res.json()) as {
        data?: {
          is_valid?: boolean;
          expires_at?: number;
          issued_at?: number;
          type?: string;
          error?: { code?: number; message?: string };
        };
        error?: { message?: string; code?: number };
      };

      if (data.error) {
        const msg = data.error.message ?? 'debug_token error';
        const code = data.error.code;
        const appCredentialError = code === 100 || /app access token|owner or developer/i.test(msg);

        this.logger.warn(`debug_token error: ${msg}`);

        return {
          ok: false,
          info: invalid,
          appCredentialError,
          errorMessage: msg,
        };
      }

      if (data.data?.error) {
        const msg = data.data.error.message ?? 'input token invalid';
        return {
          ok: false,
          info: invalid,
          appCredentialError: false,
          errorMessage: msg,
        };
      }

      const rawExpiry = data.data?.expires_at;
      const isPermanent = rawExpiry === 0;
      const expiresAt = rawExpiry != null && rawExpiry > 0 ? new Date(rawExpiry * 1000) : null;
      const issuedAt =
        data.data?.issued_at != null && data.data.issued_at > 0
          ? new Date(data.data.issued_at * 1000)
          : null;

      return {
        ok: true,
        info: {
          isValid: data.data?.is_valid === true,
          expiresAt,
          issuedAt,
          isPermanent,
          tokenType: data.data?.type ?? null,
        },
      };
    } catch (err) {
      this.logger.warn(`debug_token fetch failed: ${(err as Error).message}`);
      return {
        ok: false,
        info: invalid,
        appCredentialError: true,
        errorMessage: (err as Error).message,
      };
    }
  }

  /**
   * Validates the WhatsApp token by calling Graph with it (send-capable check).
   * Used when debug_token fails due to bad app id/secret.
   */
  private async probeTokenWithGraph(
    token: string,
    apiVersion: string,
    phoneNumberId?: string,
  ): Promise<DebugTokenInfo | null> {
    const path = phoneNumberId
      ? `${phoneNumberId}?fields=id,display_phone_number,verified_name`
      : 'me?fields=id,name';

    try {
      const url = `https://graph.facebook.com/${apiVersion}/${path}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { error?: { message?: string; code?: number } };

      if (res.ok && !data.error) {
        return {
          isValid: true,
          expiresAt: null,
          issuedAt: null,
          isPermanent: false,
          tokenType: 'graph_probe',
          expiryUnknown: true,
        };
      }

      if (data.error?.code === 190 || data.error?.code === 102) {
        return {
          isValid: false,
          expiresAt: null,
          issuedAt: null,
          isPermanent: false,
          tokenType: null,
        };
      }

      this.logger.debug(
        `Graph token probe failed (${path}): ${data.error?.message ?? res.status}`,
      );
      return null;
    } catch (err) {
      this.logger.debug(`Graph token probe error: ${(err as Error).message}`);
      return null;
    }
  }
}
