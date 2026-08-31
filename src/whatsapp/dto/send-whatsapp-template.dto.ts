import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  withReplyRoutingFields,
  withReplyRoutingShape,
} from '../types/whatsapp-reply-routing.types';

const TemplateSendParameterSchema = z.object({
  type: z.enum(['text', 'currency', 'date_time', 'image', 'document', 'video']).default('text'),
  text: z.string().optional(),
});

const TemplateButtonParameterSchema = z.object({
  index: z.coerce.number().int().min(0).default(0),
  subType: z.enum(['url', 'quick_reply']).default('url'),
  parameters: z.array(z.string()).min(1),
});

const TemplateSendComponentSchema = z.object({
  type: z.enum(['header', 'body', 'button']),
  subType: z.enum(['url', 'quick_reply']).optional(),
  index: z.coerce.number().int().min(0).optional(),
  parameters: z.array(z.union([z.string(), TemplateSendParameterSchema])).optional(),
});

const sendWhatsAppTemplateShape = {
  to: z.string().min(1, 'Recipient phone number is required'),
  /** Hexa DB template id (preferred — resolves metaTemplateName + language). */
  templateId: z.string().uuid().optional(),
  /** Meta approved template name (metaTemplateName). Required if templateId omitted. */
  templateName: z.string().min(1).optional(),
  /** Ordered body variables for {{1}}, {{2}}, … */
  parameters: z.array(z.string()).optional(),
  /** Body variables — use "1", "2" for {{1}}, {{2}} or names like "name" for {{name}}. */
  contentVariables: z.record(z.string(), z.string()).optional(),
  /** Shorthand for body parameters (same as parameters). */
  bodyParameters: z.array(z.string()).optional(),
  /** Header text parameters when template has a {{1}} header variable. */
  headerParameters: z.array(z.string()).optional(),
  /** Dynamic URL / quick-reply button parameters. */
  buttonParameters: z.array(TemplateButtonParameterSchema).optional(),
  /** Full Meta components array (overrides shorthand fields above). */
  components: z.array(TemplateSendComponentSchema).optional(),
  /** ISO language code (e.g. en, en_US). Defaults from DB template or env. */
  languageCode: z.string().min(2).max(10).optional(),
} as const;

const SendWhatsAppTemplateMergedSchema = z.object(withReplyRoutingShape(sendWhatsAppTemplateShape));

export const SendWhatsAppTemplateSchema = withReplyRoutingFields(sendWhatsAppTemplateShape).refine(
  data => Boolean(data.templateId) || Boolean(data.templateName?.trim()),
  {
    message: 'Provide templateId (company template UUID) or templateName (Meta template name)',
    path: ['templateId'],
  },
);

export class SendWhatsAppTemplateDto extends createZodDto(SendWhatsAppTemplateSchema) {}

export type SendWhatsAppTemplateInput = z.infer<typeof SendWhatsAppTemplateMergedSchema>;

/** Template send fields without recipient (used by outbound service). */
export type SendWhatsAppTemplateParams = Omit<SendWhatsAppTemplateInput, 'to'>;
