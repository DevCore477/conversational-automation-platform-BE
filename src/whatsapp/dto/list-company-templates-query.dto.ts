import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  optionalTrimmedQueryString,
  queryBoolean,
  queryInt,
} from './zod-field.util';

export const ListCompanyTemplatesQuerySchema = z.object({
  page: queryInt({ default: 1, min: 1 }).default(1),
  limit: queryInt({ default: 50, min: 1, max: 100 }).default(50),
  status: optionalTrimmedQueryString(),
  approvedOnly: queryBoolean(false).default(false),
  includeInactive: queryBoolean(false).default(false),
});

export class ListCompanyTemplatesQueryDto extends createZodDto(ListCompanyTemplatesQuerySchema) {}

export type ListCompanyTemplatesQuery = z.infer<typeof ListCompanyTemplatesQuerySchema>;
