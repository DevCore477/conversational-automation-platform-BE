import type { ValidatedUser } from '../auth/services/token-validation.service';
import type {
  ApiKeyPermissionAction,
  ApiKeyPermissionResource,
  ApiKeyPermissionsShape,
} from './api-key-permissions.types';
import type { ApiKey } from '../models/companies/api-key.entity';

/** Default permissions for new keys and for merging legacy keys missing newer sections. */
export const DEFAULT_API_KEY_PERMISSIONS: ApiKeyPermissionsShape = {
  calls: {
    create: true,
    read: true,
    update: false,
    delete: false,
  },
  scripts: {
    create: false,
    read: true,
    update: false,
    delete: false,
  },
  flows: {
    create: false,
    read: true,
    update: false,
    delete: false,
  },
  agents: {
    create: false,
    read: true,
    update: false,
    delete: false,
  },
  analytics: {
    read: true,
  },
  webhooks: {
    create: false,
    read: true,
    update: false,
    delete: false,
  },
  companies: {
    create: false,
    read: true,
    update: false,
  },
  platform: {
    read: false,
    update: false,
  },
  apiKeys: {
    create: false,
    read: true,
    update: false,
    delete: false,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const KNOWN_PERMISSION_RESOURCES = Object.keys(
  DEFAULT_API_KEY_PERMISSIONS,
) as (keyof ApiKeyPermissionsShape)[];

/** All permissions false — baseline when the client sends an explicit partial object on create/update. */
export function emptyApiKeyPermissions(): ApiKeyPermissionsShape {
  return {
    calls: { create: false, read: false, update: false, delete: false },
    scripts: { create: false, read: false, update: false, delete: false },
    flows: { create: false, read: false, update: false, delete: false },
    agents: { create: false, read: false, update: false, delete: false },
    analytics: { read: false },
    webhooks: { create: false, read: false, update: false, delete: false },
    companies: { create: false, read: false, update: false },
    platform: { read: false, update: false },
    apiKeys: { create: false, read: false, update: false, delete: false },
  };
}

/**
 * Normalize permissions when **saving** (create / PATCH).
 * - `undefined` / missing → full {@link DEFAULT_API_KEY_PERMISSIONS}
 * - `{}` or no known resource keys → defaults (same as omitting permissions)
 * - Any known resource block present → **explicit** mode: start from all-deny, then overlay only what was sent (unspecified resources stay denied)
 */
export function mergeApiKeyPermissionsForSave(
  input: ApiKey['permissions'] | null | undefined,
): ApiKeyPermissionsShape {
  if (input == null || typeof input !== 'object') {
    return structuredClone(DEFAULT_API_KEY_PERMISSIONS);
  }

  const resourceEntries = Object.entries(input).filter(
    ([key, val]) =>
      KNOWN_PERMISSION_RESOURCES.includes(key as keyof ApiKeyPermissionsShape) &&
      isPlainObject(val),
  ) as [string, Record<string, unknown>][];

  if (resourceEntries.length === 0) {
    return structuredClone(DEFAULT_API_KEY_PERMISSIONS);
  }

  const base = emptyApiKeyPermissions() as Record<string, unknown>;
  for (const [key, val] of resourceEntries) {
    const baseBlock = base[key] as Record<string, unknown>;
    base[key] = { ...baseBlock, ...val };
  }

  return base as ApiKeyPermissionsShape;
}

/**
 * Effective permissions for **auth** (validate token): defaults merged with DB JSON so legacy keys missing
 * newer sections still get sensible defaults; explicit `false` in stored wins over default `true`.
 */
export function mergeApiKeyPermissions(
  stored: ApiKey['permissions'] | null | undefined,
): ApiKeyPermissionsShape {
  const base = structuredClone(DEFAULT_API_KEY_PERMISSIONS) as Record<string, unknown>;
  if (!stored || typeof stored !== 'object') {
    return base as ApiKeyPermissionsShape;
  }

  for (const [key, val] of Object.entries(stored)) {
    if (!isPlainObject(val)) continue;
    const baseBlock = base[key];
    if (!isPlainObject(baseBlock)) {
      base[key] = { ...val };
      continue;
    }
    base[key] = { ...baseBlock, ...val };
  }

  return base as ApiKeyPermissionsShape;
}

/**
 * Whether an API key may perform `action` on `resource`.
 * Uses merged effective permissions (defaults + stored overrides).
 */
export function checkApiKeyPermission(
  effectivePermissions: ApiKeyPermissionsShape | null | undefined,
  resource: ApiKeyPermissionResource,
  action: ApiKeyPermissionAction,
): boolean {
  if (!effectivePermissions) {
    return false;
  }

  const block = effectivePermissions[resource];
  if (!block || typeof block !== 'object') {
    return false;
  }

  if (resource === 'analytics') {
    return action === 'read' && (block as Record<string, boolean | undefined>).read === true;
  }

  if (resource === 'platform') {
    if (action === 'create' || action === 'delete') {
      return false;
    }
    const v = (block as Record<string, boolean | undefined>)[action];
    return v === true;
  }

  if (resource === 'companies') {
    if (action === 'delete') {
      return false;
    }
    const v = (block as Record<string, boolean | undefined>)[action];
    return v === true;
  }

  const v = (block as Record<string, boolean | undefined>)[action];
  return v === true;
}

/** Tenant company mutations (PATCH me, users, invitations) for JWT owners/admins or API keys with `companies.update`. */
export function canManageTenantCompanyWithApiKeyOrRole(user: ValidatedUser): boolean {
  if (['owner', 'admin'].includes(user.companyRole ?? '')) {
    return true;
  }
  if (user.isApiAuthenticated) {
    return checkApiKeyPermission(user.apiKeyPermissions ?? null, 'companies', 'update');
  }
  return false;
}
