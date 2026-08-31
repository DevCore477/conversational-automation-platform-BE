-- Link local template rows to Meta template ids (filled by sync from Graph API)

ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS "metaTemplateId" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "bodyPreview" TEXT;

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_company_status
  ON whatsapp_templates ("companyId", status);
