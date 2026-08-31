import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { withReplyRoutingFields } from '../types/whatsapp-reply-routing.types';

export const SendWhatsAppMessageSchema = withReplyRoutingFields({
  to: z.string().min(1, 'Recipient phone number is required'),
  body: z.string().max(4096).optional().default(''),
  mediaUrl: z.array(z.string().url('Each mediaUrl must be a valid HTTPS URL')).max(10).optional(),
  mediaType: z.enum(['image', 'video', 'document', 'audio']).optional(),
  /** Approved template when outside Meta's 24h session window (overrides env default). */
  templateName: z.string().min(1).max(512).optional(),
  templateLanguage: z.string().min(2).max(10).optional(),
})
  .refine(data => Boolean(data.body?.trim()) || Boolean(data.mediaUrl?.length), {
    message: 'Provide message body and/or at least one mediaUrl',
    path: ['body'],
  })
  .refine(data => !data.mediaUrl?.length || (data.body?.length ?? 0) <= 1024, {
    message: 'Caption (body) should be 1024 characters or less when sending media',
    path: ['body'],
  })
  .refine(data => !data.mediaUrl?.length || data.mediaUrl.every(url => /^https:\/\//i.test(url)), {
    message: 'Meta requires publicly accessible HTTPS media URLs',
    path: ['mediaUrl'],
  });

export class SendWhatsAppMessageDto extends createZodDto(SendWhatsAppMessageSchema) {}
