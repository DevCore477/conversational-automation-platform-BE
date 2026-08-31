-- WhatsApp conversations, messages, job queue, campaigns, inbound routing

CREATE TABLE IF NOT EXISTS whatsapp_inbound_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID REFERENCES companies(id) ON DELETE CASCADE,
  "metaPhoneNumberId" VARCHAR(64) NOT NULL,
  "routingMode" VARCHAR(32) NOT NULL DEFAULT 'ai',
  "agentId" UUID,
  "flowId" UUID,
  "scriptId" UUID,
  "aiModel" VARCHAR(64) DEFAULT 'gpt-4o-mini',
  "aiSystemPrompt" TEXT,
  "sendGreetingOnFirstMessage" BOOLEAN NOT NULL DEFAULT true,
  "markInboundAsRead" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_inbound_config_phone
  ON whatsapp_inbound_config ("metaPhoneNumberId");

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID REFERENCES companies(id) ON DELETE SET NULL,
  "contactPhone" VARCHAR(32) NOT NULL,
  "contactWaId" VARCHAR(32),
  "metaPhoneNumberId" VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  "routingMode" VARCHAR(32),
  "agentId" UUID,
  "flowId" UUID,
  "scriptId" UUID,
  "sessionState" JSONB,
  "lastMessageAt" TIMESTAMPTZ,
  "lastInboundAt" TIMESTAMPTZ,
  "lastOutboundAt" TIMESTAMPTZ,
  "unreadCount" INT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_conversation_contact
  ON whatsapp_conversations ("metaPhoneNumberId", "contactPhone");

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversation_company
  ON whatsapp_conversations ("companyId", "lastMessageAt" DESC);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  direction VARCHAR(16) NOT NULL,
  "messageType" VARCHAR(32) NOT NULL DEFAULT 'text',
  body TEXT,
  "mediaUrl" TEXT,
  "metaWamid" VARCHAR(128),
  status VARCHAR(24) NOT NULL DEFAULT 'received',
  "statusUpdatedAt" TIMESTAMPTZ,
  "errorCode" VARCHAR(32),
  "errorMessage" TEXT,
  payload JSONB,
  "sentAt" TIMESTAMPTZ,
  "deliveredAt" TIMESTAMPTZ,
  "readAt" TIMESTAMPTZ,
  "failedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_wamid
  ON whatsapp_messages ("metaWamid") WHERE "metaWamid" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation
  ON whatsapp_messages ("conversationId", "createdAt");

CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID REFERENCES companies(id) ON DELETE SET NULL,
  name VARCHAR(255),
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  "designType" VARCHAR(32),
  "totalCount" INT NOT NULL DEFAULT 0,
  "sentCount" INT NOT NULL DEFAULT 0,
  "failedCount" INT NOT NULL DEFAULT 0,
  "dryRun" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS whatsapp_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "jobType" VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  priority INT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}',
  "conversationId" UUID REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  "campaignId" UUID REFERENCES whatsapp_campaigns(id) ON DELETE SET NULL,
  "dedupeKey" VARCHAR(128),
  attempts INT NOT NULL DEFAULT 0,
  "maxAttempts" INT NOT NULL DEFAULT 5,
  "scheduledAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lockedAt" TIMESTAMPTZ,
  "lockedBy" VARCHAR(64),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_jobs_poll
  ON whatsapp_jobs (status, "scheduledAt", priority DESC)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_whatsapp_jobs_dedupe
  ON whatsapp_jobs ("dedupeKey", status)
  WHERE "dedupeKey" IS NOT NULL AND status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_whatsapp_jobs_conversation
  ON whatsapp_jobs ("conversationId", status);
