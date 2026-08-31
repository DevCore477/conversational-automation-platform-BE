-- Seed: Insert "Vet Clinic NO" script for Norwegian inbound callers (+47).
-- Run this once so Norwegian callers get the vet flow. Script body is injected at runtime from config (vet-clinic.config.ts).
-- Adjust column names if your DB uses camelCase (e.g. firstMessage) from TypeORM synchronize.

INSERT INTO call_scripts (
  name,
  script,
  description,
  first_message,
  model,
  is_active,
  is_default,
  call_type
)
VALUES (
  'Vet Clinic NO',
  'Norwegian veterinary appointment booking. Script body is injected at runtime from config.',
  'Vet clinic script for Norwegian callers (+47) and for outbound testing. Alternate weekends only.',
  'Hallo, du ringer til dyreklinikken. Hvordan kan jeg hjelpe deg i dag?',
  'gpt-4',
  true,
  false,
  'both'
)
ON CONFLICT (name) DO UPDATE SET
  script = EXCLUDED.script,
  description = EXCLUDED.description,
  first_message = EXCLUDED.first_message,
  model = EXCLUDED.model,
  is_active = EXCLUDED.is_active,
  call_type = 'both';
