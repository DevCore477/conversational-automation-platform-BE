import { registerAs } from '@nestjs/config';

export default registerAs('mozo', () => ({
  // App Store marketplace OAuth (MozoTokenService, POST /mozo/auth/token) — a SEPARATE Mozo
  // product from the direct venue API below. Its real base URL/host is unconfirmed; nothing
  // in this codebase has verified it against a live server. See src/mozo/README.md.
  clientId: process.env.MOZO_CLIENT_ID ?? '',
  clientSecret: process.env.MOZO_CLIENT_SECRET ?? '',
  webhookSecret: process.env.MOZO_WEBHOOK_SECRET ?? '',
  apiUrl: process.env.MOZO_API_URL ?? '',
  // Mozo's real direct venue/POS API (MozoApiService: menu/orders/venue) — confirmed live
  // against https://testapiv2.themozo.net. Auth is a static X-API-Key header, not OAuth.
  // See src/mozo/README.md for exactly which endpoints are confirmed vs. unconfirmed.
  directApiUrl: process.env.MOZO_DIRECT_API_URL ?? '',
  developerAuthKey: process.env.MOZO_DEVELOPER_AUTH_KEY ?? '',
  /** Origins allowed to call /mozo/* from a browser (the widget running inside Mozo's iframe). */
  allowedOrigins: (process.env.MOZO_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  /**
   * Plain infra secret shared with the Mozo bridge — proves "this caller is allowed to
   * mint an embedded session" for POST /auth/embedded-session. Not part of the
   * ApiKeyPermissions system, never shown in any UI, never rotatable by end users.
   * Generate with `openssl rand -hex 32`; set identically on both sides.
   */
  bridgeSharedSecret: process.env.MOZO_BRIDGE_SHARED_SECRET ?? '',
  /** Single-tenant: the one company every embedded session / /mozo/hexaai/activity call resolves to. */
  singleTenantCompanyId: process.env.MOZO_SINGLE_TENANT_COMPANY_ID ?? '',
  /**
   * Fallback Mozo venue_id used only by in-process callers that don't pass one explicitly
   * (e.g. the conversation-flow tools in flow-tools/mozo-order.tool.ts). The HTTP endpoints
   * (/mozo/menu, /mozo/orders, /mozo/orders/:id, /mozo/venue) always require venue_id on the
   * request and never fall back to this — see MozoController/MozoApiService.
   */
  singleTenantVenueId: process.env.MOZO_SINGLE_TENANT_VENUE_ID ?? '',
}));
