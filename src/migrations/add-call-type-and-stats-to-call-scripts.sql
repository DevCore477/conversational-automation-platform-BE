-- Migration: Add call_type and usage statistics to call_scripts table
-- This migration adds support for both inbound and outbound scripts with usage tracking

-- Add call_type column
ALTER TABLE call_scripts 
ADD COLUMN IF NOT EXISTS call_type VARCHAR(20) DEFAULT 'both' NOT NULL;

-- Add usage statistics columns
ALTER TABLE call_scripts 
ADD COLUMN IF NOT EXISTS total_calls INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE call_scripts 
ADD COLUMN IF NOT EXISTS successful_calls INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE call_scripts 
ADD COLUMN IF NOT EXISTS failed_calls INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE call_scripts 
ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP;

-- Create index on call_type for faster filtering
CREATE INDEX IF NOT EXISTS idx_call_scripts_call_type ON call_scripts(call_type);

-- Create index on last_used_at for analytics queries
CREATE INDEX IF NOT EXISTS idx_call_scripts_last_used_at ON call_scripts(last_used_at DESC);

-- Add check constraint for call_type
ALTER TABLE call_scripts 
ADD CONSTRAINT IF NOT EXISTS chk_call_type 
CHECK (call_type IN ('inbound', 'outbound', 'both'));

-- Update existing scripts to have 'inbound' as default (maintaining backward compatibility)
UPDATE call_scripts 
SET call_type = 'inbound' 
WHERE call_type = 'both';

-- Add comments
COMMENT ON COLUMN call_scripts.call_type IS 'Type of calls this script is for: inbound, outbound, or both';
COMMENT ON COLUMN call_scripts.total_calls IS 'Total number of calls made using this script';
COMMENT ON COLUMN call_scripts.successful_calls IS 'Number of successful calls using this script';
COMMENT ON COLUMN call_scripts.failed_calls IS 'Number of failed calls using this script';
COMMENT ON COLUMN call_scripts.last_used_at IS 'Timestamp of when this script was last used';

