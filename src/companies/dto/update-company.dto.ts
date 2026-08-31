import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateCompanySchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().optional(),
  industry: z.string().optional(),
  website: z.url().optional().or(z.literal('')),
  email: z.email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export class UpdateCompanyDto extends createZodDto(UpdateCompanySchema) {}
