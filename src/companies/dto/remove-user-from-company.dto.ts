import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RemoveUserFromCompanySchema = z.object({
  userId: z.uuid('Invalid user ID'),
});

export class RemoveUserFromCompanyDto extends createZodDto(RemoveUserFromCompanySchema) {}
