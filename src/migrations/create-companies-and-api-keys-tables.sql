-- Migration: Create companies and api_keys tables for multi-tenancy
-- This enables multiple companies to use the platform with isolated data

-- Create companies table
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) UNIQUE NOT NULL,
  slug VARCHAR(200) UNIQUE NOT NULL,
  description TEXT,
  website VARCHAR(255),
  industry VARCHAR(100),
  
  -- Theme and branding
  logo VARCHAR(255),
  icon VARCHAR(255),
  primary_color VARCHAR(20) DEFAULT '#3B82F6' NOT NULL,
  secondary_color VARCHAR(20) DEFAULT '#1E40AF' NOT NULL,
  
  -- Contact info
  email VARCHAR(255),
  phone VARCHAR(50),
  address TEXT,
  
  -- Settings (JSONB for flexibility)
  settings JSONB,
  
  -- Subscription
  plan VARCHAR(50) DEFAULT 'free' NOT NULL,
  is_active BOOLEAN DEFAULT true NOT NULL,
  trial_ends_at TIMESTAMP,
  subscription_ends_at TIMESTAMP,
  
  -- Usage tracking
  calls_this_month INTEGER DEFAULT 0 NOT NULL,
  total_calls INTEGER DEFAULT 0 NOT NULL,
  total_users INTEGER DEFAULT 0 NOT NULL,
  
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Create api_keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  key VARCHAR(64) UNIQUE NOT NULL,
  key_prefix VARCHAR(16) UNIQUE NOT NULL,
  description TEXT,
  
  -- Permissions and restrictions (JSONB)
  permissions JSONB DEFAULT '{}' NOT NULL,
  restrictions JSONB,
  
  -- Usage tracking
  total_requests INTEGER DEFAULT 0 NOT NULL,
  last_used_at TIMESTAMP,
  last_used_ip VARCHAR(100),
  
  -- Status
  is_active BOOLEAN DEFAULT true NOT NULL,
  expires_at TIMESTAMP,
  created_by UUID,
  
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Add company_id to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS company_role VARCHAR(50) DEFAULT 'user';

-- Add company_id to call_scripts table
ALTER TABLE call_scripts 
ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

-- Add company_id to call_records table
ALTER TABLE call_records 
ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);
CREATE INDEX IF NOT EXISTS idx_companies_is_active ON companies(is_active);
CREATE INDEX IF NOT EXISTS idx_companies_plan ON companies(plan);

CREATE INDEX IF NOT EXISTS idx_api_keys_company_id ON api_keys(company_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_is_active ON api_keys(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_call_scripts_company_id ON call_scripts(company_id);
CREATE INDEX IF NOT EXISTS idx_call_records_company_id ON call_records(company_id);

-- Add comments
COMMENT ON TABLE companies IS 'Stores company/organization information for multi-tenancy';
COMMENT ON TABLE api_keys IS 'API keys for company integrations and external access';

COMMENT ON COLUMN companies.slug IS 'URL-friendly unique identifier for the company';
COMMENT ON COLUMN companies.settings IS 'Flexible JSON settings including integrations, features, and preferences';
COMMENT ON COLUMN companies.plan IS 'Subscription plan: free, starter, professional, enterprise';

COMMENT ON COLUMN api_keys.key IS 'Hashed API key for security';
COMMENT ON COLUMN api_keys.key_prefix IS 'First 16 characters for display purposes (e.g., sk_live_abc123...)';
COMMENT ON COLUMN api_keys.permissions IS 'Granular permissions for API access';
COMMENT ON COLUMN api_keys.restrictions IS 'IP whitelist, rate limits, and other restrictions';

COMMENT ON COLUMN users.company_id IS 'Company the user belongs to';
COMMENT ON COLUMN users.company_role IS 'Role within the company: owner, admin, user';
COMMENT ON COLUMN call_scripts.company_id IS 'Company that owns this script';
COMMENT ON COLUMN call_records.company_id IS 'Company that owns this call record';

-- Insert a default company for existing data (optional)
INSERT INTO companies (name, slug, description, plan, is_active)
VALUES (
  'Default Company',
  'default',
  'Auto-created company for existing users',
  'professional',
  true
)
ON CONFLICT (slug) DO NOTHING;

-- Update existing users to belong to default company
UPDATE users 
SET company_id = (SELECT id FROM companies WHERE slug = 'default' LIMIT 1)
WHERE company_id IS NULL;

-- Update existing call_scripts to belong to default company
UPDATE call_scripts 
SET company_id = (SELECT id FROM companies WHERE slug = 'default' LIMIT 1)
WHERE company_id IS NULL;

-- Update existing call_records to belong to default company
UPDATE call_records 
SET company_id = (SELECT id FROM companies WHERE slug = 'default' LIMIT 1)
WHERE company_id IS NULL;

