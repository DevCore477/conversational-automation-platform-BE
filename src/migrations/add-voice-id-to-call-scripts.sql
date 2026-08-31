-- Migration: Add voiceId column to call_scripts table
-- Date: 2026-01-15
-- Description: Adds ElevenLabs voice ID support to call scripts for customizable voices

-- Add voiceId column to call_scripts table
ALTER TABLE call_scripts
ADD COLUMN IF NOT EXISTS "voiceId" VARCHAR(100) NULL;

-- Add comment to explain the column
COMMENT ON COLUMN call_scripts."voiceId" IS 'ElevenLabs voice ID to use for this script';

-- Create index for faster lookups by voiceId (optional but recommended)
CREATE INDEX IF NOT EXISTS idx_call_scripts_voice_id ON call_scripts("voiceId");

