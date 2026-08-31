-- WhatsApp template library: extended template metadata, cache, campaign variable mapping

ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS "qualityStatus" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "source" VARCHAR(24) NOT NULL DEFAULT 'synced',
  ADD COLUMN IF NOT EXISTS "libraryTemplateName" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_company_active
  ON whatsapp_templates ("companyId", "isActive", status);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_meta_id
  ON whatsapp_templates ("companyId", "metaTemplateId")
  WHERE "metaTemplateId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_template_library_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "searchKey" VARCHAR(512) NOT NULL,
  language VARCHAR(16),
  category VARCHAR(64),
  topic VARCHAR(64),
  "resultJson" JSONB NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_template_library_cache_lookup
  ON whatsapp_template_library_cache ("companyId", "searchKey", "expiresAt");

ALTER TABLE whatsapp_campaigns
  ADD COLUMN IF NOT EXISTS "templateVariableMapping" JSONB;
