import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WebsiteBlogStatusValues } from '../enums/website-blog-status.enum';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const UpdateWebsiteBlogSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  /** Changing this moves the public URL — the slug is otherwise stable across title edits. */
  slug: z
    .string()
    .min(1)
    .max(280)
    .regex(slugPattern, 'slug must be lowercase, alphanumeric, hyphen-separated')
    .optional(),
  shortDescription: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  featuredImage: z.url().max(500).optional().nullable(),
  images: z.array(z.url().max(500)).optional(),
  authorName: z.string().min(1).max(150).optional(),
  category: z.string().min(1).max(100).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).optional(),
  status: z.enum(WebsiteBlogStatusValues).optional(),
  metaTitle: z.string().max(255).optional().nullable(),
  metaDescription: z.string().max(500).optional().nullable(),
  metaKeywords: z.string().max(500).optional().nullable(),
  canonicalUrl: z.url().max(500).optional().nullable(),
});

export type UpdateWebsiteBlogInput = z.infer<typeof UpdateWebsiteBlogSchema>;

export class UpdateWebsiteBlogDto extends createZodDto(UpdateWebsiteBlogSchema) {}
