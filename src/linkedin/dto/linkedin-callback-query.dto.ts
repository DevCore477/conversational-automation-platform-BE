import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const LinkedInCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type LinkedInCallbackQueryInput = z.infer<typeof LinkedInCallbackQuerySchema>;

export class LinkedInCallbackQueryDto extends createZodDto(LinkedInCallbackQuerySchema) {}
