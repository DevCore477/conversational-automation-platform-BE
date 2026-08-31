import { SetMetadata } from '@nestjs/common';

import type {
  ApiKeyPermissionAction,
  ApiKeyPermissionResource,
} from '../../api-keys/api-key-permissions.types';

export const API_KEY_PERMISSION_KEY = 'apiKeyPermission';

export interface ApiKeyPermissionMeta {
  resource: ApiKeyPermissionResource;
  action: ApiKeyPermissionAction;
}

/** Enforced for `Bearer sk_*` requests when {@link ApiKeyPermissionGuard} is registered. JWT users skip this check. */
export const RequireApiKeyPermission = (
  resource: ApiKeyPermissionResource,
  action: ApiKeyPermissionAction,
) => SetMetadata(API_KEY_PERMISSION_KEY, { resource, action } satisfies ApiKeyPermissionMeta);
