import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { ApiKeyPermissionMeta } from '../auth/decorators/require-api-key-permission.decorator';
import { API_KEY_PERMISSION_KEY } from '../auth/decorators/require-api-key-permission.decorator';
import type { ValidatedUser } from '../auth/services/token-validation.service';
import { checkApiKeyPermission } from '../api-keys/api-key-permissions.util';

@Injectable()
export class ApiKeyPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<ApiKeyPermissionMeta | undefined>(
      API_KEY_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!meta) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: ValidatedUser }>();
    const user = request.user;

    if (!user?.isApiAuthenticated) {
      return true;
    }

    if (!checkApiKeyPermission(user.apiKeyPermissions, meta.resource, meta.action)) {
      throw new ForbiddenException(
        `API key is not allowed to ${meta.action} ${meta.resource}. Update the key permissions or use a user session.`,
      );
    }

    return true;
  }
}
