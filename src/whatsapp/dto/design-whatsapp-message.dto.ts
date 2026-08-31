import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WhatsAppMessageDesignSchema } from '../types/message-design.types';
import {
  withReplyRoutingFields,
  withReplyRoutingShape,
} from '../types/whatsapp-reply-routing.types';

export const PreviewWhatsAppDesignSchema = z.object({
  design: WhatsAppMessageDesignSchema,
  variables: z.record(z.string(), z.string()).optional(),
  examplePhone: z.string().optional(),
});

export class PreviewWhatsAppDesignDto extends createZodDto(PreviewWhatsAppDesignSchema) {}

const sendDesignedWhatsAppShape = {
  to: z.string().min(1),
  design: WhatsAppMessageDesignSchema,
  variables: z.record(z.string(), z.string()).optional(),
} as const;

const SendDesignedWhatsAppMergedSchema = z.object(withReplyRoutingShape(sendDesignedWhatsAppShape));

export const SendDesignedWhatsAppSchema = withReplyRoutingFields(sendDesignedWhatsAppShape);

export class SendDesignedWhatsAppDto extends createZodDto(SendDesignedWhatsAppSchema) {}

export type SendDesignedWhatsAppInput = z.infer<typeof SendDesignedWhatsAppMergedSchema>;
