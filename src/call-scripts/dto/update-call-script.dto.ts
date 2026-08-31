import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CallType } from '../../common/enums';

export const UpdateCallScriptSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .optional(),
  script: z.string().min(10, 'Script must be at least 10 characters').optional(),
  description: z.string().optional(),
  firstMessage: z.string().max(255, 'First message must be less than 255 characters').optional(),
  model: z.string().optional(),
  voiceId: z.string().max(100, 'Voice ID must be less than 100 characters').optional(),
  callType: z.enum(CallType).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  companyId: z.string().optional(),
});

export class UpdateCallScriptDto extends createZodDto(UpdateCallScriptSchema) {}
