// guards/unified-auth.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';

import { TokenValidationService } from '../auth/services/token-validation.service';

export interface AuthGuardOptions {
  allowApiKey?: boolean;
  allowJwt?: boolean;
  optional?: boolean;
}

@Injectable()
export class UnifiedAuthGuard implements CanActivate {
  private readonly logger = new Logger(UnifiedAuthGuard.name);

  // Hardcoded default options - no constructor injection
  protected allowApiKey = true;
  protected allowJwt = true;
  protected optional = false;

  constructor(protected readonly tokenValidationService: TokenValidationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      if (this.optional) {
        return true;
      }
      throw new UnauthorizedException('Missing authorization header');
    }

    const token = authHeader.substring(7);
    const tokenType = this.tokenValidationService.detectTokenType(token);

    try {
      let user;

      if (tokenType === 'api_key' && this.allowApiKey) {
        user = await this.tokenValidationService.validateApiKey(token, request.ip);
      } else if (tokenType === 'jwt' && this.allowJwt) {
        user = await this.tokenValidationService.validateJwtToken(token);
      } else {
        throw new UnauthorizedException('Invalid token type');
      }

      request.user = user;
      return true;
    } catch (error) {
      if (this.optional) {
        this.logger.debug(`Optional auth failed: ${error.message}`);
        return true;
      }
      throw error;
    }
  }
}
