import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { MozoPublicKeyService } from '../services/mozo-public-key.service';

/**
 * Verifies the caller sent a real `iframe_session` token signed by Mozo, via
 * `Authorization: Bearer <token>` — RS256 signature checked against Mozo's published
 * public key (GET /v4/app-store/auth/public-key, see MozoPublicKeyService).
 *
 * What this DOES verify: the token is a genuine, unexpired, RS256-signed JWT from Mozo's
 * key (jsonwebtoken checks `exp` automatically when present).
 *
 * What this does NOT verify — app-store-iframe-sessions.md isn't available to confirm the
 * exact claim shape — is anything claim-level: that the token's venue matches
 * MOZO_SINGLE_TENANT_VENUE_ID, that a host-origin claim matches the calling origin, or
 * anything else beyond "Mozo signed this." Tighten this once that doc is available.
 */
@Injectable()
export class MozoIframeSessionGuard implements CanActivate {
  private readonly logger = new Logger(MozoIframeSessionGuard.name);

  constructor(
    private readonly publicKeyService: MozoPublicKeyService,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Mozo iframe session token');
    }
    const token = authHeader.slice(7);

    let publicKey: string;
    try {
      publicKey = await this.publicKeyService.getPublicKey();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not fetch Mozo's public key: ${message}`);
      // Our infra problem, not the caller's — 502, not 401, so this doesn't look like a bad token.
      throw new HttpException(`Could not verify Mozo iframe session: ${message}`, 502);
    }

    try {
      await this.jwtService.verifyAsync(token, { publicKey, algorithms: ['RS256'] });
    } catch (err) {
      this.logger.warn(
        `Mozo iframe session token rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('Invalid Mozo iframe session token');
    }

    return true;
  }
}
