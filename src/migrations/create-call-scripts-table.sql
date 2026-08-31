-- Migration: Create call_scripts table
-- This table stores dynamic call scripts for inbound calls

CREATE TABLE IF NOT EXISTS call_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  script TEXT NOT NULL,
  description TEXT,
  first_message VARCHAR(255),
  model VARCHAR(50) DEFAULT 'gpt-4' NOT NULL,
  is_active BOOLEAN DEFAULT false NOT NULL,
  is_default BOOLEAN DEFAULT false NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create index on is_default for faster queries
CREATE INDEX IF NOT EXISTS idx_call_scripts_is_default ON call_scripts(is_default) WHERE is_default = true;

-- Create index on is_active for faster queries
CREATE INDEX IF NOT EXISTS idx_call_scripts_is_active ON call_scripts(is_active);

-- Create index on name for faster lookups
CREATE INDEX IF NOT EXISTS idx_call_scripts_name ON call_scripts(name);

-- Insert a default script
INSERT INTO call_scripts (name, script, description, first_message, model, is_active, is_default)
VALUES (
  'Default Customer Support',
  'You are a professional AI assistant. Greet callers warmly and ask how you can help them today. Listen carefully to their needs and respond helpfully. Keep responses concise and under 30 seconds. Be polite, professional, and friendly. If you cannot help with something, politely let them know and offer to take a message.',
  'Default script for inbound calls',
  'Hello! How may I assist you today?',
  'gpt-4',
  true,
  true
)
ON CONFLICT (name) DO NOTHING;

-- Add comment to table
COMMENT ON TABLE call_scripts IS 'Stores dynamic call scripts for managing inbound call AI behavior';
COMMENT ON COLUMN call_scripts.script IS 'The AI system prompt that defines assistant behavior';
COMMENT ON COLUMN call_scripts.first_message IS 'Optional custom greeting message for the call';
COMMENT ON COLUMN call_scripts.is_default IS 'Only one script should be default at a time';
COMMENT ON COLUMN call_scripts.is_active IS 'Inactive scripts cannot be set as default';

