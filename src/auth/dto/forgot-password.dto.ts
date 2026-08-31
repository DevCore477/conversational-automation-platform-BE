import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ForgotPasswordSchema = z.object({
  email: z.email('Valid email is required'),
});

export class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}
