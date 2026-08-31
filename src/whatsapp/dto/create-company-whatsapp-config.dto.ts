import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateCompanyWhatsAppConfigSchema = z.object({
  wabaId: z.string().optional(),
  phoneNumberId: z.string().min(1),
  businessPhoneNumber: z.string().optional(),
  accessToken: z.string().min(1),
  appSecret: z.string().optional(),
  webhookVerifyToken: z.string().optional(),
  apiVersion: z.string().optional(),
  isActive: z.boolean().optional(),
  maxMessagesPerSecond: z.number().int().positive().optional(),
  maxMessagesPerMinute: z.number().int().positive().optional(),
  maxDailyMessages: z.number().int().positive().optional(),
});

export class CreateCompanyWhatsAppConfigDto extends createZodDto(
  CreateCompanyWhatsAppConfigSchema,
) {}
