import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { withReplyRoutingShape } from '../types/whatsapp-reply-routing.types';

const CampaignRecipientSchema = z.object({
  phone: z.string().min(5).max(32),
  name: z.string().max(255).optional(),
  templateParams: z.array(z.string()).optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

export const CreateWhatsAppCampaignSchema = z
  .object(
    withReplyRoutingShape({
      name: z.string().min(1).max(255),
      templateId: z.string().uuid(),
      /** External WhatsApp numbers — not Hexa AI user ids */
      recipients: z.array(CampaignRecipientSchema).optional(),
      /** Shorthand list of E.164 numbers */
      phones: z.array(z.string().min(5).max(32)).optional(),
      /** Optional: existing whatsapp_contacts row ids (same company) */
      contactIds: z.array(z.string().uuid()).optional(),
      templateParamsByPhone: z.record(z.string(), z.array(z.string())).optional(),
      templateParamsByContact: z.record(z.string(), z.array(z.string())).optional(),
      /** Default placeholder mapping for all recipients (slot → value, e.g. "1": "{{name}}"). */
      templateVariableMapping: z.record(z.string(), z.string()).optional(),
      /** Company confirms uploaded numbers have WhatsApp marketing opt-in */
      confirmRecipientsOptedIn: z.boolean().optional(),
      scheduledAt: z.string().datetime().optional(),
    }),
  )
  .refine(
    data => {
      const count =
        (data.recipients?.length ?? 0) +
        (data.phones?.length ?? 0) +
        (data.contactIds?.length ?? 0);
      return count > 0;
    },
    { message: 'Provide recipients, phones, and/or contactIds' },
  )
  .refine(
    data => {
      if (!data.routingMode) {
        return true;
      }
      switch (data.routingMode) {
        case 'agent':
          return Boolean(data.agentId);
        case 'flow':
          return Boolean(data.flowId);
        case 'script':
          return Boolean(data.scriptId);
        default:
          return true;
      }
    },
    {
      message:
        'agentId is required for agent routing, flowId for flow routing, scriptId for script routing',
    },
  );

export class CreateWhatsAppCampaignDto extends createZodDto(CreateWhatsAppCampaignSchema) {}
