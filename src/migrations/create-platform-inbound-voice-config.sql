-- Platform-level inbound routing: which agent, flow, or script to use for /webhook/inbound
-- when the call is not routed to a company by phone number.
-- Application expects at most one row; upsert logic uses the first row if multiple exist.

CREATE TABLE IF NOT EXISTS platform_inbound_voice_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platformCompanyId" uuid NULL,
  "routingMode" varchar(32) NOT NULL DEFAULT 'database_default',
  "agentId" uuid NULL,
  "flowId" uuid NULL,
  "scriptId" uuid NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_inbound_voice_config IS 'Platform default inbound: route to agent, flow, script, or database default script';
