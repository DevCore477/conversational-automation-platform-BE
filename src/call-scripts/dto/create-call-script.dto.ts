import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CallType } from '../../common/enums';

export const CreateCallScriptSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  script: z.string().min(10, 'Script must be at least 10 characters'),
  description: z.string().optional(),
  firstMessage: z.string().max(255, 'First message must be less than 255 characters').optional(),
  model: z.string().default('gpt-4'),
  voiceId: z.string().max(100, 'Voice ID must be less than 100 characters').optional(),
  callType: z.enum(CallType).default('both'),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  companyId: z.string().optional(),
});

export type CreateCallScriptInput = z.infer<typeof CreateCallScriptSchema>;

export class CreateCallScriptDto extends createZodDto(CreateCallScriptSchema) {}
