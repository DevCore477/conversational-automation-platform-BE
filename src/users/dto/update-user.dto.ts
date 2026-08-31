import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateUserSchema = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  email: z.email().optional(),
  role: z.enum(['admin', 'member']).optional(),
});

export type UpdateUserDtoType = z.infer<typeof UpdateUserSchema>;

export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
