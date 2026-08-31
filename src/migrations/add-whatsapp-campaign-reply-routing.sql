-- Per-campaign reply routing: agent, flow, script, or custom AI prompt for inbound replies

ALTER TABLE whatsapp_campaigns
  ADD COLUMN IF NOT EXISTS "routingMode" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "agentId" UUID,
  ADD COLUMN IF NOT EXISTS "flowId" UUID,
  ADD COLUMN IF NOT EXISTS "scriptId" UUID,
  ADD COLUMN IF NOT EXISTS "aiModel" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "aiSystemPrompt" TEXT;
