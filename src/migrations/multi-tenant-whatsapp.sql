-- Multi-tenant WhatsApp: company configs, contacts, templates, extended campaigns/messages/conversations

CREATE TABLE IF NOT EXISTS company_whatsapp_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider VARCHAR(16) NOT NULL DEFAULT 'meta',
  "wabaId" VARCHAR(64),
  "phoneNumberId" VARCHAR(64) NOT NULL,
  "businessPhoneNumber" VARCHAR(32),
  "accessTokenEncrypted" TEXT NOT NULL,
  "appSecretEncrypted" TEXT,
  "webhookVerifyToken" VARCHAR(255),
  "apiVersion" VARCHAR(16) NOT NULL DEFAULT 'v25.0',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "maxMessagesPerSecond" INT,
  "maxMessagesPerMinute" INT,
  "maxDailyMessages" INT,
  "qualityStatus" VARCHAR(32),
  "messagingTier" VARCHAR(32),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_whatsapp_config_company
  ON company_whatsapp_configs ("companyId");

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_whatsapp_config_phone
  ON company_whatsapp_configs ("phoneNumberId");

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  "phoneNumber" VARCHAR(32) NOT NULL,
  name VARCHAR(255),
  "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false,
  "whatsappOptInSource" VARCHAR(64),
  "whatsappOptInAt" TIMESTAMPTZ,
  "whatsappUnsubscribed" BOOLEAN NOT NULL DEFAULT false,
  "whatsappBlocked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_contacts_company_phone
  ON whatsapp_contacts ("companyId", "phoneNumber");

CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_company_optin
  ON whatsapp_contacts ("companyId", "whatsappOptIn", "whatsappUnsubscribed");

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  "metaTemplateName" VARCHAR(128) NOT NULL,
  category VARCHAR(64),
  language VARCHAR(16) NOT NULL DEFAULT 'en',
  status VARCHAR(32) NOT NULL DEFAULT 'approved',
  components JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_templates_company_meta
  ON whatsapp_templates ("companyId", "metaTemplateName", language);

-- Extend conversations
ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS "contactId" UUID REFERENCES whatsapp_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "serviceWindowExpiresAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "assignedAgentId" UUID;

DROP INDEX IF EXISTS idx_whatsapp_conversation_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_conversation_company_contact
  ON whatsapp_conversations ("companyId", "metaPhoneNumberId", "contactPhone");

-- Extend messages
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS "companyId" UUID REFERENCES companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS "contactId" UUID REFERENCES whatsapp_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "campaignId" UUID REFERENCES whatsapp_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "phoneNumber" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "templateName" VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_company_campaign
  ON whatsapp_messages ("companyId", "campaignId");

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_company_wamid
  ON whatsapp_messages ("companyId", "metaWamid") WHERE "metaWamid" IS NOT NULL;

-- Extend campaigns
ALTER TABLE whatsapp_campaigns
  ADD COLUMN IF NOT EXISTS "templateId" UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "queuedCount" INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deliveredCount" INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "readCount" INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "skippedCount" INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "createdByUserId" UUID,
  ADD COLUMN IF NOT EXISTS "pauseReason" TEXT;

-- Backfill message companyId from conversations
UPDATE whatsapp_messages m
SET "companyId" = c."companyId"
FROM whatsapp_conversations c
WHERE m."conversationId" = c.id AND m."companyId" IS NULL AND c."companyId" IS NOT NULL;
