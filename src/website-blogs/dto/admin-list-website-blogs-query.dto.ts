import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WebsiteBlogStatusValues } from '../enums/website-blog-status.enum';

export const AdminListWebsiteBlogsQuerySchema = z.object({
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
  status: z.enum(WebsiteBlogStatusValues).optional(),
  category: z.string().optional(),
});

export type AdminListWebsiteBlogsQueryInput = z.infer<typeof AdminListWebsiteBlogsQuerySchema>;

export class AdminListWebsiteBlogsQueryDto extends createZodDto(AdminListWebsiteBlogsQuerySchema) {}
