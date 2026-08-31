import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WHATSAPP_TEMPLATE_CATEGORIES } from '../../common/enums/whatsapp.enum';
import {
  firstQueryValue,
  optionalTrimmedQueryString,
  queryBoolean,
  queryInt,
} from './zod-field.util';

const categoryQuery = z.preprocess(value => {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toUpperCase();
    return trimmed.length ? trimmed : undefined;
  }
  return raw;
}, z.enum(WHATSAPP_TEMPLATE_CATEGORIES).optional());

export const SearchTemplateLibraryQuerySchema = z.object({
  search: optionalTrimmedQueryString(),
  language: optionalTrimmedQueryString(),
  category: categoryQuery,
  topic: optionalTrimmedQueryString(),
  name: optionalTrimmedQueryString(),
  limit: queryInt({ default: 25, min: 1, max: 100 }).default(25),
  after: optionalTrimmedQueryString(),
  skipCache: queryBoolean(false).default(false),
});

export class SearchTemplateLibraryQueryDto extends createZodDto(SearchTemplateLibraryQuerySchema) {}

export type SearchTemplateLibraryQuery = z.infer<typeof SearchTemplateLibraryQuerySchema>;
