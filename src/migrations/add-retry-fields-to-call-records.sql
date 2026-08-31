-- Migration: Add retry tracking fields to call_records table
-- This enables automatic retry of failed calls

ALTER TABLE call_records 
ADD COLUMN IF NOT EXISTS retry_attempts INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE call_records 
ADD COLUMN IF NOT EXISTS max_retry_attempts INTEGER DEFAULT 3 NOT NULL;

ALTER TABLE call_records 
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP;

ALTER TABLE call_records 
ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMP;

-- Create index for efficient retry queries
CREATE INDEX IF NOT EXISTS idx_call_records_next_retry_at 
ON call_records(next_retry_at) 
WHERE next_retry_at IS NOT NULL AND status IN ('initiating', 'failed');

-- Add comments
COMMENT ON COLUMN call_records.retry_attempts IS 'Number of retry attempts made for this call';
COMMENT ON COLUMN call_records.max_retry_attempts IS 'Maximum number of retries allowed (default: 3)';
COMMENT ON COLUMN call_records.next_retry_at IS 'Timestamp for next retry attempt';
COMMENT ON COLUMN call_records.last_retry_at IS 'Timestamp of last retry attempt';

