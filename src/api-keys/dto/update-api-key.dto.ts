import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { FlexibleDateTime, FlexiblePermissions, RestrictionsSchema } from './api-key-shared.schema';

export const UpdateApiKeySchema = z.object({
  name: z
    .string()
    .min(3, 'API key name must be at least 3 characters')
    .max(100, 'API key name must be less than 100 characters')
    .optional(),
  description: z.string().optional(),
  permissions: FlexiblePermissions,
  restrictions: RestrictionsSchema,
  expiresAt: FlexibleDateTime,
  /** Set to `false` to revoke (deactivate) the key; `true` to re-enable. */
  isActive: z.boolean().optional(),
});

export class UpdateApiKeyDto extends createZodDto(UpdateApiKeySchema) {}
