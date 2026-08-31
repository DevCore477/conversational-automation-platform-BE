import { Injectable, Logger } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';

import mozoConfig from '../../configs/mozo.config';
import { extractMozoErrorMessage, isRecord } from '../utils/mozo-error.util';

/** Rotation isn't documented — refetch periodically rather than caching forever. */
const PUBLIC_KEY_CACHE_MS = 60 * 60 * 1000;

/**
 * Fetches and caches Mozo's JWT signing public key — `GET /v4/app-store/auth/public-key`,
 * confirmed public/no-auth per app-store-quickstart.md. Used by MozoIframeSessionGuard to
 * verify iframe_session tokens the Mozo widget sends.
 *
 * This endpoint's response shape isn't documented beyond "fetch the public key," so parsing
 * here is defensive: accepts either a JSON field (`public_key`/`publicKey`/`key`) containing
 * PEM text, or the raw response body itself being PEM text.
 */
@Injectable()
export class MozoPublicKeyService {
  private readonly logger = new Logger(MozoPublicKeyService.name);
  private readonly apiUrl: string;
  private cached: { key: string; fetchedAt: number } | null = null;

  constructor(configService: ConfigService) {
    this.apiUrl = configService.getOrThrow<ConfigType<typeof mozoConfig>>('mozo').apiUrl;
  }

  async getPublicKey(): Promise<string> {
    if (this.cached && Date.now() - this.cached.fetchedAt < PUBLIC_KEY_CACHE_MS) {
      return this.cached.key;
    }

    const response = await fetch(`${this.apiUrl}/v4/app-store/auth/public-key`);
    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Mozo public-key fetch failed: ${extractMozoErrorMessage(this.tryParseJson(rawText), response.status)}`,
      );
    }

    const key = this.extractPemKey(rawText);
    if (!key) {
      throw new Error('Mozo public-key response did not contain a recognizable PEM key');
    }

    this.cached = { key, fetchedAt: Date.now() };
    this.logger.log('Mozo public key refreshed');
    return key;
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private extractPemKey(rawText: string): string | null {
    const trimmed = rawText.trim();
    if (trimmed.startsWith('-----BEGIN')) {
      return trimmed;
    }

    const json = this.tryParseJson(trimmed);
    if (isRecord(json)) {
      for (const field of ['public_key', 'publicKey', 'key']) {
        const value = json[field];
        if (typeof value === 'string' && value.includes('BEGIN')) {
          return value;
        }
      }
    }

    return null;
  }
}
