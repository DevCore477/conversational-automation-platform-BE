import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { queryInt } from './zod-field.util';

export const ListCampaignRecipientsQuerySchema = z.object({
  page: queryInt({ default: 1, min: 1 }).default(1),
  limit: queryInt({ default: 50, min: 1, max: 500 }).default(50),
  /** Super Admin only — scope campaign lookup to a company when omitted from JWT */
  companyId: z.string().uuid().optional(),
});

export class ListCampaignRecipientsQueryDto extends createZodDto(
  ListCampaignRecipientsQuerySchema,
) {}
