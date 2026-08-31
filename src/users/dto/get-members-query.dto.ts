import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { UserRole } from '../../common/enums';

export const GetMembersQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .default('1')
    .transform(val => parseInt(val, 10))
    .refine(val => val > 0, 'Page must be greater than 0'),
  limit: z
    .string()
    .optional()
    .default('10')
    .transform(val => parseInt(val, 10))
    .refine(val => val > 0 && val <= 100, 'Limit must be between 1 and 100'),
  search: z
    .string()
    .optional()
    .transform(val => (val ? val.trim() : undefined)),
  role: z.enum(UserRole).optional(),
  companyId: z.string().uuid('Invalid company ID').optional(),
  sortBy: z.enum(['createdAt', 'email', 'firstName', 'lastName']).optional().default('createdAt'),
  sortOrder: z.enum(['ASC', 'DESC']).optional().default('DESC'),
});

export class GetMembersQueryDto extends createZodDto(GetMembersQuerySchema) {}
