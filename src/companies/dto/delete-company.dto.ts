import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const DeleteCompanySchema = z.object({
  confirmCompanyName: z
    .string()
    .min(1)
    .describe('Must match the company `name` exactly (after trim) to confirm destructive delete'),
});

export class DeleteCompanyDto extends createZodDto(DeleteCompanySchema) {}
