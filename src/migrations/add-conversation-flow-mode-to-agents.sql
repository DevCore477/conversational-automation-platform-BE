-- Agents: rigid vs flex stepping when response engine is conversation-flow (default rigid).
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS "conversationFlowMode" varchar(20) NOT NULL DEFAULT 'rigid';

COMMENT ON COLUMN agents."conversationFlowMode" IS 'rigid | flex — how strictly the agent follows the flow (conversation-flow engine only; default rigid)';
