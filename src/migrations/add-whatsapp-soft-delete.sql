-- Soft delete for inbox cleanup without losing campaign audit history

ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_active
  ON whatsapp_conversations ("companyId", "lastMessageAt" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_campaign_active
  ON whatsapp_messages ("campaignId", "createdAt")
  WHERE "campaignId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation_active
  ON whatsapp_messages ("conversationId", "createdAt")
  WHERE "deletedAt" IS NULL;
