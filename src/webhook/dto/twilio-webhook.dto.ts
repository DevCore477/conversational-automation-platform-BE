import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const twilioWebhookSchema = z.object({
  CallSid: z.string(),
  AccountSid: z.string().optional(),
  From: z.string().optional(),
  To: z.string().optional(),
  CallStatus: z.string().optional(),
  Direction: z.string().optional(),
  ApiVersion: z.string().optional(),
  ForwardedFrom: z.string().optional(),
  CallerName: z.string().optional(),
  Duration: z.string().optional(),
  RecordingUrl: z.string().optional(),
  Timestamp: z.string().optional(),
});

export class TwilioWebhookDto extends createZodDto(twilioWebhookSchema) {}
