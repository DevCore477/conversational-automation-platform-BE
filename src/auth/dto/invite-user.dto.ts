import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { UserRole } from '../../common/enums';

export const InviteUserSchema = z.object({
  email: z.email('Valid email is required'),
  expiresInHours: z
    .number()
    .min(1, 'Expiration must be at least 1 hour')
    .max(24 * 14, 'Expiration cannot exceed 14 days')
    .optional(),
  role: z.enum(UserRole).optional(),
});

export class InviteUserDto extends createZodDto(InviteUserSchema) {}
