import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WhatsAppMessageDesignSchema } from '../types/message-design.types';
import { withReplyRoutingFields } from '../types/whatsapp-reply-routing.types';

const recipientSchema = z.object({
  to: z.string().min(1),
  message: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  parameters: z.array(z.string()).optional(),
});

export const BulkSendWhatsAppSchema = withReplyRoutingFields({
  design: WhatsAppMessageDesignSchema,
  recipients: z.array(recipientSchema).min(1),
  delayMs: z.number().int().min(0).max(10000).optional(),
  dryRun: z.boolean().optional(),
  stopOnError: z.boolean().optional(),
});

export class BulkSendWhatsAppDto extends createZodDto(BulkSendWhatsAppSchema) {}

export const BulkSendTextWhatsAppSchema = withReplyRoutingFields({
  message: z.string().min(1).max(4096),
  recipients: z.array(recipientSchema).min(1),
  delayMs: z.number().int().min(0).max(10000).optional(),
  dryRun: z.boolean().optional(),
  stopOnError: z.boolean().optional(),
});

export class BulkSendTextWhatsAppDto extends createZodDto(BulkSendTextWhatsAppSchema) {}
