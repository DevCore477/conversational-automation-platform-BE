/**
 * Stored on {@link ApiKey} and validated by Zod when creating/updating keys.
 * Aligns with tenant API surface: calls, scripts, flows, agents, dashboard, webhooks, company settings, platform routing, and API key self-management.
 */
export interface ApiKeyCrudPermissions {
  create?: boolean;
  read?: boolean;
  update?: boolean;
  delete?: boolean;
}

export interface ApiKeyAnalyticsPermissions {
  read?: boolean;
}

export interface ApiKeyCompanyPermissions {
  create?: boolean;
  read?: boolean;
  update?: boolean;
}

export interface ApiKeyPlatformPermissions {
  read?: boolean;
  update?: boolean;
}

export interface ApiKeyPermissionsShape {
  calls?: ApiKeyCrudPermissions;
  scripts?: ApiKeyCrudPermissions;
  flows?: ApiKeyCrudPermissions;
  agents?: ApiKeyCrudPermissions;
  analytics?: ApiKeyAnalyticsPermissions;
  webhooks?: ApiKeyCrudPermissions;
  companies?: ApiKeyCompanyPermissions;
  platform?: ApiKeyPlatformPermissions;
  apiKeys?: ApiKeyCrudPermissions;
}

export type ApiKeyPermissionResource = keyof ApiKeyPermissionsShape;

export type ApiKeyPermissionAction = 'create' | 'read' | 'update' | 'delete';
