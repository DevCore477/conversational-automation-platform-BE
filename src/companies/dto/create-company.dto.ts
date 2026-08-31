import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateCompanySchema = z.object({
  name: z
    .string()
    .min(2, 'Company name must be at least 2 characters')
    .max(200, 'Company name must be less than 200 characters'),
  email: z.email('Invalid email address'),
  description: z.string().optional(),
  industry: z.string().optional(),
  website: z.url('Invalid website URL').optional().or(z.literal('')),
});

export class CreateCompanyDto extends createZodDto(CreateCompanySchema) {}
