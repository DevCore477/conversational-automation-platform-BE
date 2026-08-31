-- Migration: Add usage statistics to conversation_flows (aligned with call_scripts)

ALTER TABLE conversation_flows
  ADD COLUMN IF NOT EXISTS "totalCalls" integer NOT NULL DEFAULT 0;

ALTER TABLE conversation_flows
  ADD COLUMN IF NOT EXISTS "successfulCalls" integer NOT NULL DEFAULT 0;

ALTER TABLE conversation_flows
  ADD COLUMN IF NOT EXISTS "failedCalls" integer NOT NULL DEFAULT 0;

ALTER TABLE conversation_flows
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_conversation_flows_last_used_at ON conversation_flows ("lastUsedAt" DESC);

COMMENT ON COLUMN conversation_flows."totalCalls" IS 'Total number of calls using this flow';
COMMENT ON COLUMN conversation_flows."successfulCalls" IS 'Successful call count (same semantics as call_scripts)';
COMMENT ON COLUMN conversation_flows."failedCalls" IS 'Failed call count';
COMMENT ON COLUMN conversation_flows."lastUsedAt" IS 'Last time this flow was used on a call';
