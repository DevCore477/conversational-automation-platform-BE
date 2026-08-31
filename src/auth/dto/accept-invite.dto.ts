import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AcceptInviteSchema = z
  .object({
    token: z.string().min(1, 'Invitation token is required'),
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(8, 'Confirm password must be at least 8 characters'),
  })
  .refine(data => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export class AcceptInviteDto extends createZodDto(AcceptInviteSchema) {}
