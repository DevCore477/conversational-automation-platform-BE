import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WhatsAppTemplateStatus } from '../../common/enums/whatsapp.enum';

export const UpdateWhatsAppTemplateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  category: z.string().max(64).optional().nullable(),
  status: z
    .enum([
      WhatsAppTemplateStatus.PENDING,
      WhatsAppTemplateStatus.APPROVED,
      WhatsAppTemplateStatus.REJECTED,
      WhatsAppTemplateStatus.PAUSED,
      WhatsAppTemplateStatus.DISABLED,
    ])
    .optional(),
  components: z.array(z.record(z.string(), z.unknown())).optional().nullable(),
  bodyPreview: z.string().max(2000).optional().nullable(),
});

export class UpdateWhatsAppTemplateDto extends createZodDto(UpdateWhatsAppTemplateSchema) {}
