import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

import mozoConfig from '../../configs/mozo.config';

function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

/**
 * Gates POST /auth/embedded-session on a plain shared secret (X-Mozo-Bridge-Secret),
 * not the ApiKeyPermissions system — this proves "this caller is our Mozo bridge
 * infra," a different trust level than "this company's API key can do X."
 */
@Injectable()
export class MozoBridgeSecretGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredSecret =
      this.configService.getOrThrow<ConfigType<typeof mozoConfig>>('mozo').bridgeSharedSecret;
    if (!configuredSecret) {
      throw new UnauthorizedException('Mozo bridge secret not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-mozo-bridge-secret'];

    if (typeof provided !== 'string' || !safeCompare(provided, configuredSecret)) {
      throw new UnauthorizedException('Invalid bridge secret');
    }

    return true;
  }
}
