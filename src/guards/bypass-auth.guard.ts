import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { mergeApiKeyPermissions } from '../api-keys/api-key-permissions.util';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class TrustedOriginOrAttachUserGuard implements CanActivate {
  private readonly logger = new Logger(TrustedOriginOrAttachUserGuard.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly apiKeysService: ApiKeysService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const origin = request.headers.origin;

    const trustedOrigin = this.configService.get<string>('calls.frontendBaseUrl');
    const backendURL = this.configService.get<string>('calls.backendBaseUrl');

    this.logger.debug(
      `Checking origin: ${origin}, trusted: ${trustedOrigin}, backend: ${backendURL}`,
    );

    // ✅ TRUSTED ORIGIN: Allow through without any auth check, but try to attach user if token provided
    if (origin === backendURL || origin === trustedOrigin) {
      this.logger.log(`Trusted origin detected: ${origin}`);

      // Optionally attach user if they provided a token (soft auth)
      await this.tryAttachUser(request);

      return true; // Always allow trusted origins
    }

    // ❌ UNTRUSTED ORIGIN: Must provide valid auth, and we attach the user
    this.logger.log(`Untrusted origin: ${origin}, requiring authentication`);
    return this.requireAuthAndAttachUser(request);
  }

  /**
   * Soft authentication - attaches user if token provided, but never throws
   */
  private async tryAttachUser(request: any): Promise<void> {
    const authHeader: string | undefined = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return; // No token, no problem - request continues without user
    }

    const token = authHeader.substring(7);

    try {
      if (token.startsWith('sk_')) {
        await this.attachApiKeyUser(request, token);
      } else {
        await this.attachJwtUser(request, token);
      }
    } catch (error) {
      // Log but don't block - trusted origins are allowed anonymous access
      this.logger.debug(`Optional auth failed for trusted origin: ${error.message}`);
    }
  }

  /**
   * Hard authentication - must provide valid auth for untrusted origins
   */
  private async requireAuthAndAttachUser(request: any): Promise<boolean> {
    const authHeader: string | undefined = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      // No auth provided for untrusted origin - allow anonymous but log warning
      this.logger.warn(`Anonymous request from untrusted origin: ${request.ip}`);
      // Return true to allow, or throw UnauthorizedException if you want to block
      return true; // Change to `throw new UnauthorizedException()` if you want to block
    }

    const token = authHeader.substring(7);

    if (token.startsWith('sk_')) {
      return this.attachApiKeyUser(request, token);
    } else {
      return this.attachJwtUser(request, token);
    }
  }

  private async attachApiKeyUser(request: any, apiKey: string): Promise<boolean> {
    const validation = await this.apiKeysService.validate(apiKey, request.ip);

    if (!validation.isValid) {
      this.logger.warn(`Invalid API key from untrusted origin: ${validation.error}`);
      // For untrusted origins, you might want to block invalid keys
      // return false; // or throw new UnauthorizedException()
      return true; // Or allow with warning
    }

    request.company = validation.company;
    request.apiKey = validation.apiKey;
    const keyId = validation.apiKey!.id;
    request.user = {
      id: `api_${keyId}`,
      userId: `api_${keyId}`,
      companyId: validation.company!.id,
      companyRole: 'api',
      role: 'member',
      isApiAuthenticated: true,
      apiKeyPermissions: mergeApiKeyPermissions(validation.apiKey!.permissions),
      email: `api-key@${validation.company!.slug}`,
      firstName: 'API',
      lastName: 'Key',
    };

    this.logger.log(`API key attached for company: ${validation.company!.name}`);
    return true;
  }

  private async attachJwtUser(request: any, token: string): Promise<boolean> {
    try {
      const authCfg = this.configService.getOrThrow('auth');
      const payload = await this.jwtService.verifyAsync(token, {
        secret: authCfg.jwtSecret,
      });

      const user = await this.usersService.findById(payload.sub);

      request.user = {
        ...user,
        userId: user.id,
        companyId: user.companyId || payload.companyId,
        companyRole: user.companyRole || payload.companyRole,
        isApiAuthenticated: false,
      };

      this.logger.debug(`JWT user attached: ${user.email}`);
      return true;
    } catch (error) {
      this.logger.warn(`Invalid JWT from untrusted origin: ${error.message}`);
      // For untrusted origins, decide if you want to block or allow
      // throw new UnauthorizedException("Invalid token");
      return true; // Allow but without user attached
    }
  }
}
