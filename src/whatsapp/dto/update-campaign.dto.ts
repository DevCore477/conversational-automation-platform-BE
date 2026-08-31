import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateWhatsAppCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
  })
  .refine(data => data.name !== undefined, {
    message: 'Provide at least one field to update',
  });

export class UpdateWhatsAppCampaignDto extends createZodDto(UpdateWhatsAppCampaignSchema) {}
