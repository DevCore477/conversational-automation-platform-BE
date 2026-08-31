import { z } from 'zod';

import type { WhatsAppReplyRoutingInput } from './whatsapp-reply-routing.types';

const textDesignSchema = z.object({
  type: z.literal('text'),
  body: z.string().min(1).max(4096),
  previewUrl: z.boolean().optional(),
});

const templateDesignSchema = z.object({
  type: z.literal('template'),
  templateName: z.string().min(1),
  parameters: z.array(z.string()).optional(),
  languageCode: z.string().min(2).max(10).optional(),
});

const mediaDesignSchema = z.object({
  type: z.literal('media'),
  mediaType: z.enum(['image', 'video', 'document', 'audio']).default('image'),
  url: z.url(),
  caption: z.string().max(1024).optional(),
});

const buttonSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(20),
});

const interactiveButtonsDesignSchema = z.object({
  type: z.literal('interactive_buttons'),
  body: z.string().min(1).max(1024),
  footer: z.string().max(60).optional(),
  header: z
    .object({
      type: z.literal('text'),
      text: z.string().min(1).max(60),
    })
    .optional(),
  buttons: z.array(buttonSchema).min(1).max(3),
});

const listRowSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(24),
  description: z.string().max(72).optional(),
});

const listSectionSchema = z.object({
  title: z.string().min(1).max(24),
  rows: z.array(listRowSchema).min(1).max(10),
});

const interactiveListDesignSchema = z.object({
  type: z.literal('interactive_list'),
  body: z.string().min(1).max(1024),
  footer: z.string().max(60).optional(),
  buttonText: z.string().min(1).max(20),
  sections: z.array(listSectionSchema).min(1).max(10),
});

export const WhatsAppMessageDesignSchema = z.discriminatedUnion('type', [
  textDesignSchema,
  templateDesignSchema,
  mediaDesignSchema,
  interactiveButtonsDesignSchema,
  interactiveListDesignSchema,
]);

export type WhatsAppMessageDesign = z.infer<typeof WhatsAppMessageDesignSchema>;

export interface BulkRecipientRow {
  to: string;
  message?: string;
  variables?: Record<string, string>;
  parameters?: string[];
}

export interface BulkSendOptions extends WhatsAppReplyRoutingInput {
  delayMs?: number;
  dryRun?: boolean;
  stopOnError?: boolean;
}

export interface BulkSendResultItem {
  to: string;
  success: boolean;
  messageSid?: string;
  status?: string;
  error?: string;
  preview?: string;
}

export interface BulkSendResult {
  campaignId: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
  designType: string;
  results: BulkSendResultItem[];
}
