import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WhatsAppConversationStatus } from '../../common/enums/whatsapp.enum';

export const UpdateConversationStatusSchema = z.object({
  status: z.enum([
    WhatsAppConversationStatus.OPEN,
    WhatsAppConversationStatus.CLOSED,
    WhatsAppConversationStatus.HUMAN_HANDOFF,
  ]),
});

export class UpdateConversationStatusDto extends createZodDto(UpdateConversationStatusSchema) {}
