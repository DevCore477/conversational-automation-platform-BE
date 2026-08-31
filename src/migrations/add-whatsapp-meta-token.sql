-- Cached Meta Graph API access token (auto-refreshed via fb_exchange_token)

CREATE TABLE IF NOT EXISTS whatsapp_meta_token (
  id VARCHAR(32) PRIMARY KEY DEFAULT 'default',
  "accessToken" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
