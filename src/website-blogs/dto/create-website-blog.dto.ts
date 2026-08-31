import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WebsiteBlogStatusValues } from '../enums/website-blog-status.enum';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateWebsiteBlogSchema = z.object({
  title: z.string().min(1).max(255),
  /** Optional — auto-generated from `title` and de-duplicated when omitted. */
  slug: z
    .string()
    .min(1)
    .max(280)
    .regex(slugPattern, 'slug must be lowercase, alphanumeric, hyphen-separated')
    .optional(),
  shortDescription: z.string().min(1).max(500),
  content: z.string().min(1),
  featuredImage: z.url().max(500).optional().nullable(),
  images: z.array(z.url().max(500)).optional().default([]),
  authorName: z.string().min(1).max(150),
  category: z.string().min(1).max(100).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).optional().default([]),
  status: z.enum(WebsiteBlogStatusValues).optional(),
  metaTitle: z.string().max(255).optional().nullable(),
  metaDescription: z.string().max(500).optional().nullable(),
  metaKeywords: z.string().max(500).optional().nullable(),
  canonicalUrl: z.url().max(500).optional().nullable(),
});

export type CreateWebsiteBlogInput = z.infer<typeof CreateWebsiteBlogSchema>;

export class CreateWebsiteBlogDto extends createZodDto(CreateWebsiteBlogSchema) {}
