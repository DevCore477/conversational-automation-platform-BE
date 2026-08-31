// auth/services/token-validation.service.ts
import { Global, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserRole } from '../../common/enums';
import type { ApiKeyPermissionsShape } from '../../api-keys/api-key-permissions.types';
import { mergeApiKeyPermissions } from '../../api-keys/api-key-permissions.util';
import { ApiKeysService } from '../../api-keys/api-keys.service';
import authConfig from '../../configs/auth.config';
import { Company } from '../../models/companies/company.entity';
import { UsersService } from '../../users/users.service';

export interface ValidatedUser {
  id: string;
  email: string;
  role: string;
  companyId?: string;
  companyRole?: string;
  isApiAuthenticated: boolean;
  /** Effective permissions (defaults merged with stored JSON) when `isApiAuthenticated`. */
  apiKeyPermissions?: ApiKeyPermissionsShape;
  firstName?: string;
  lastName?: string;
}

interface JwtAccessPayload {
  sub: string;
  email?: string;
  role?: string;
  companyId?: string;
  companyRole?: string;
}

function asJwtAccessPayload(value: unknown): JwtAccessPayload {
  if (typeof value !== 'object' || value === null || !('sub' in value)) {
    throw new UnauthorizedException('Invalid or expired token');
  }
  const o = value as Record<string, unknown>;
  const sub = o.sub;
  if (typeof sub !== 'string') {
    throw new UnauthorizedException('Invalid or expired token');
  }
  return {
    sub,
    email: typeof o.email === 'string' ? o.email : undefined,
    role: typeof o.role === 'string' ? o.role : undefined,
    companyId: typeof o.companyId === 'string' ? o.companyId : undefined,
    companyRole: typeof o.companyRole === 'string' ? o.companyRole : undefined,
  };
}

@Global()
@Injectable()
export class TokenValidationService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly apiKeysService: ApiKeysService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {}

  async validateJwtToken(token: string): Promise<ValidatedUser> {
    try {
      const authCfg = this.configService.getOrThrow<ConfigType<typeof authConfig>>('auth');
      const verified: unknown = await this.jwtService.verifyAsync(token, {
        secret: authCfg.jwtSecret,
      });
      const payload = asJwtAccessPayload(verified);

      const user = await this.usersService.findById(payload.sub);

      if (user.role !== UserRole.ADMIN && user.companyId) {
        const company = await this.companyRepository.findOne({
          where: { id: user.companyId },
        });
        if (company && !company.isActive) {
          throw new UnauthorizedException('This company has been deactivated');
        }
      }

      return {
        id: user.id,
        email: user.email,
        role: user.role,
        companyId: user.companyId ?? payload.companyId,
        companyRole: user.companyRole,
        isApiAuthenticated: false,
        firstName: user.firstName,
        lastName: user.lastName,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async validateApiKey(apiKey: string, ip: string): Promise<ValidatedUser> {
    const validation = await this.apiKeysService.validate(apiKey, ip);

    if (!validation.isValid) {
      throw new UnauthorizedException(validation.error ?? 'Invalid API key');
    }

    const keyEntity = validation.apiKey;
    const company = validation.company;
    if (keyEntity == null || company == null) {
      throw new UnauthorizedException('Invalid API key');
    }

    return {
      id: `api_${keyEntity.id}`,
      email: `api-key@${company.slug}`,
      role: 'member',
      companyId: company.id,
      companyRole: 'api',
      isApiAuthenticated: true,
      apiKeyPermissions: mergeApiKeyPermissions(keyEntity.permissions),
      firstName: 'API',
      lastName: 'Key',
    };
  }

  detectTokenType(token: string): 'jwt' | 'api_key' | 'unknown' {
    if (token.startsWith('sk_')) return 'api_key';
    if (token.split('.').length === 3) return 'jwt';
    return 'unknown';
  }
}
