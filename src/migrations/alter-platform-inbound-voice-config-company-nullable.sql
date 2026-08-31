-- Allow platform inbound config without a tenant: global / default routing by resource id only.
ALTER TABLE platform_inbound_voice_config
  ALTER COLUMN "platformCompanyId" DROP NOT NULL;
