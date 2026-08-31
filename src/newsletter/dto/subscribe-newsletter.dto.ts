import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SubscribeNewsletterSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Invalid email address')),
});

export class SubscribeNewsletterDto extends createZodDto(SubscribeNewsletterSchema) {}
