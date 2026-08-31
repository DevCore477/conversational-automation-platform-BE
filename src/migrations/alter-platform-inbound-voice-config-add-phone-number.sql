-- Adds per-Telnyx-number company routing to platform_inbound_voice_config.
-- "phoneNumber" IS NULL rows remain the legacy single platform-default row (unchanged behavior).
-- "phoneNumber" IS NOT NULL rows map one Telnyx DID -> one company's agent/flow/script (inbound)
-- and double as that company's outbound caller-ID number (looked up by "platformCompanyId").

ALTER TABLE platform_inbound_voice_config
  ADD COLUMN IF NOT EXISTS "phoneNumber" varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true;

-- Postgres unique indexes treat every NULL as distinct, so this enforces "at most one row per
-- real number" while leaving the existing "one default row" convention enforced at the app layer.
CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_inbound_voice_config_phone_number
  ON platform_inbound_voice_config ("phoneNumber")
  WHERE "phoneNumber" IS NOT NULL;

COMMENT ON COLUMN platform_inbound_voice_config."phoneNumber" IS
  'E.164 Telnyx DID. NULL = legacy platform-default row. Set = per-company number: inbound routing by this number, outbound caller-ID by "platformCompanyId".';
