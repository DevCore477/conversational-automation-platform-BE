-- Stores user + agent transcript turns for analytics and review.

ALTER TABLE call_records
  ADD COLUMN IF NOT EXISTS conversation_transcript JSONB;

COMMENT ON COLUMN call_records.conversation_transcript IS 'Array of { role: user|agent, text, at? } turns';
