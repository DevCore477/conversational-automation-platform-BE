-- Migration: Create call_records table
-- This table stores persistent call history for analytics and statistics

CREATE TABLE IF NOT EXISTS call_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid VARCHAR(100) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL,
  phone_number_from VARCHAR(50) NOT NULL,
  phone_number_to VARCHAR(50) NOT NULL,
  script TEXT NOT NULL,
  model VARCHAR(50) NOT NULL,
  provider VARCHAR(50),
  script_id UUID,
  script_name VARCHAR(100),
  call_type VARCHAR(20),
  duration INTEGER,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMP
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_call_records_call_sid ON call_records(call_sid);
CREATE INDEX IF NOT EXISTS idx_call_records_status ON call_records(status);
CREATE INDEX IF NOT EXISTS idx_call_records_script_id ON call_records(script_id);
CREATE INDEX IF NOT EXISTS idx_call_records_created_at ON call_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_records_completed_at ON call_records(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_records_call_type ON call_records(call_type);

-- Add comments
COMMENT ON TABLE call_records IS 'Stores persistent call history for analytics and reporting';
COMMENT ON COLUMN call_records.call_sid IS 'Unique call SID from Twilio';
COMMENT ON COLUMN call_records.status IS 'Call status: initiating, active, completed, failed';
COMMENT ON COLUMN call_records.script_id IS 'Reference to the script used for this call';
COMMENT ON COLUMN call_records.call_type IS 'Type of call: inbound or outbound';
COMMENT ON COLUMN call_records.duration IS 'Call duration in seconds';

