import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const BroadcastNewsletterSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(255),
  html: z.string().trim().min(1, 'Email content (html) is required'),
  text: z.string().trim().optional(),
});

export class BroadcastNewsletterDto extends createZodDto(BroadcastNewsletterSchema) {}
