import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WhatsAppTemplateStatus } from '../../common/enums/whatsapp.enum';

export const CreateWhatsAppTemplateSchema = z.object({
  /** Display name in Hexa AI */
  name: z.string().min(1).max(128),
  /** Exact template name in Meta Business Manager (case-sensitive) */
  metaTemplateName: z.string().min(1).max(128),
  language: z.string().min(2).max(16).default('en'),
  category: z.string().max(64).optional(),
  status: z
    .enum([
      WhatsAppTemplateStatus.PENDING,
      WhatsAppTemplateStatus.APPROVED,
      WhatsAppTemplateStatus.REJECTED,
      WhatsAppTemplateStatus.PAUSED,
      WhatsAppTemplateStatus.DISABLED,
    ])
    .default(WhatsAppTemplateStatus.APPROVED),
  components: z.array(z.record(z.string(), z.unknown())).optional(),
  bodyPreview: z.string().max(2000).optional(),
});

export class CreateWhatsAppTemplateDto extends createZodDto(CreateWhatsAppTemplateSchema) {}
