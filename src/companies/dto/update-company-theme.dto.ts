import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateCompanyThemeSchema = z.object({
  logo: z.union([z.url('Invalid logo URL'), z.literal('')]).optional(),
  icon: z.union([z.url('Invalid icon URL'), z.literal('')]).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color')
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color')
    .optional(),
});

export class UpdateCompanyThemeDto extends createZodDto(UpdateCompanyThemeSchema) {}
