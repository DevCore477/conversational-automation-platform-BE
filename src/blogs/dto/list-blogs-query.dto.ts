import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ListBlogsQuerySchema = z.object({
  status: z.enum(['draft', 'published']).optional(),
});

export type ListBlogsQueryInput = z.infer<typeof ListBlogsQuerySchema>;

export class ListBlogsQueryDto extends createZodDto(ListBlogsQuerySchema) {}
