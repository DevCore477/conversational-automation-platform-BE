import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Reset token is required'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(8, 'Confirm password must be at least 8 characters'),
  })
  .refine(data => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
