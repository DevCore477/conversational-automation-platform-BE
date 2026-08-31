import { Injectable, Logger } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';

import mozoConfig from '../../configs/mozo.config';
import { extractMozoErrorMessage, isRecord } from '../utils/mozo-error.util';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** Exchanges MOZO_CLIENT_ID/SECRET for a per-venue Mozo app access token; caches and auto-refreshes it. */
@Injectable()
export class MozoTokenService {
  private readonly logger = new Logger(MozoTokenService.name);
  private readonly cache = new Map<string, CachedToken>();
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiUrl: string;

  constructor(configService: ConfigService) {
    const cfg = configService.getOrThrow<ConfigType<typeof mozoConfig>>('mozo');
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.apiUrl = cfg.apiUrl;
  }

  /** Cached access token for `venueId`, refreshed when fewer than 60s of life remain. */
  async getAppAccessToken(venueId: string): Promise<string> {
    const cached = this.cache.get(venueId);
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      return cached.accessToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('MOZO_CLIENT_ID / MOZO_CLIENT_SECRET not set');
    }

    let response;

    try {
      response = await fetch(`${this.apiUrl}/v4/app-store/auth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          venue_id: venueId,
        }),
      });
    } catch (error) {
      this.logger.error('Token Exchange Error');
      console.error('Mozo fetch failed:', {
        message: error?.message ?? 'unknown error',
        cause: error?.cause ?? 'unknown cause',
        url: this.apiUrl,
      });

      throw error;
    }
    const json: unknown = await response.json().catch(() => null);
    this.logger.debug(`Mozo token exchange response for venue ${venueId}: ${JSON.stringify(json)}`);
    if (!response.ok) {
      throw new Error(`token exchange failed: ${extractMozoErrorMessage(json, response.status)}`);
    }

    // Response is flat per Mozo's docs — { access_token, token_type, expires_in, expires_at,
    // scopes, installation, app } — NOT nested under a `data` field.
    const data = isRecord(json) ? json : {};
    const accessToken = typeof data.access_token === 'string' ? data.access_token : undefined;
    if (!accessToken) {
      throw new Error('token exchange response missing access_token');
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;

    this.cache.set(venueId, {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    this.logger.log(`Mozo app access token refreshed for venue ${venueId}`);
    return accessToken;
  }
}
