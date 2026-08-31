import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { FlexibleDateTime, FlexiblePermissions, RestrictionsSchema } from './api-key-shared.schema';

export const CreateApiKeySchema = z.object({
  name: z
    .string()
    .min(3, 'API key name must be at least 3 characters')
    .max(100, 'API key name must be less than 100 characters'),
  description: z.string().optional(),
  permissions: FlexiblePermissions,
  restrictions: RestrictionsSchema,
  expiresAt: FlexibleDateTime,
});

export class CreateApiKeyDto extends createZodDto(CreateApiKeySchema) {}
