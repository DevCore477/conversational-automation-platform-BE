import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  firstQueryValue,
  optionalCoerceBoolean,
  optionalTrimmedQueryString,
  queryInt,
} from './zod-field.util';

export const ListConversationsQuerySchema = z.object({
  page: queryInt({ default: 1, min: 1 }).default(1),
  limit: queryInt({ default: 20, min: 1, max: 100 }).default(20),
  status: optionalTrimmedQueryString().transform(val =>
    val ? val.toLowerCase() : undefined,
  ),
  unreadOnly: optionalCoerceBoolean(),
  search: optionalTrimmedQueryString(),
  contactId: z.preprocess(value => {
    const v = firstQueryValue(value);
    if (v === undefined || v === null || v === '') {
      return undefined;
    }
    return v;
  }, z.string().uuid('Invalid contact ID').optional()),
  sortBy: z
    .enum(['lastMessageAt', 'createdAt', 'unreadCount'])
    .optional()
    .default('lastMessageAt'),
  sortOrder: z.enum(['ASC', 'DESC']).optional().default('DESC'),
});

export class ListConversationsQueryDto extends createZodDto(ListConversationsQuerySchema) {}

export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;
