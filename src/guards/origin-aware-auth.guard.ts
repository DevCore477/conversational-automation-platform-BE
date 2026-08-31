// guards/origin-aware-auth.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TokenValidationService } from '../auth/services/token-validation.service';

@Injectable()
export class OriginAwareAuthGuard implements CanActivate {
  private readonly logger = new Logger(OriginAwareAuthGuard.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly tokenValidationService: TokenValidationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const origin = request.headers.origin;

    const trustedOrigins = [
      this.configService.get<string>('calls.frontendBaseUrl'),
      this.configService.get<string>('calls.backendBaseUrl'),
    ].filter(Boolean);

    const isTrustedOrigin = trustedOrigins.includes(origin);

    this.logger.debug(`Request from origin: ${origin}, trusted: ${isTrustedOrigin}`);

    // For trusted origins, auth is optional
    if (isTrustedOrigin) {
      await this.tryAttachUser(request);
      return true;
    }

    // For untrusted origins, require auth
    return this.requireAuth(request);
  }

  private async tryAttachUser(request: any): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return;
    }

    const token = authHeader.substring(7);
    const tokenType = this.tokenValidationService.detectTokenType(token);

    try {
      if (tokenType === 'api_key') {
        const user = await this.tokenValidationService.validateApiKey(token, request.ip);
        request.user = user;
      } else if (tokenType === 'jwt') {
        const user = await this.tokenValidationService.validateJwtToken(token);
        request.user = user;
      }
    } catch (error) {
      this.logger.debug(`Optional auth failed: ${error.message}`);
    }
  }

  private async requireAuth(request: any): Promise<boolean> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      this.logger.warn(`Anonymous request from untrusted origin: ${request.ip}`);
      return true; // Or throw new UnauthorizedException() to block
    }

    const token = authHeader.substring(7);
    const tokenType = this.tokenValidationService.detectTokenType(token);

    if (tokenType === 'api_key') {
      request.user = await this.tokenValidationService.validateApiKey(token, request.ip);
    } else if (tokenType === 'jwt') {
      request.user = await this.tokenValidationService.validateJwtToken(token);
    } else {
      throw new UnauthorizedException('Invalid token type');
    }

    return true;
  }
}
