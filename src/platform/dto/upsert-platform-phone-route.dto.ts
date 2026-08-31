import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { RoutingMode, requireIdForRoutingMode } from './upsert-platform-inbound-voice.dto';

export const UpsertPlatformPhoneRouteSchema = z
  .object({
    /** The Telnyx DID this route applies to, e.g. "+3197010269438". */
    phoneNumber: z.string().min(4).max(32),
    /** Company that owns this number for both inbound routing and outbound caller ID. */
    platformCompanyId: z.string().uuid('platformCompanyId must be a UUID'),
    routingMode: RoutingMode,
    agentId: z.string().uuid().optional().nullable(),
    flowId: z.string().uuid().optional().nullable(),
    scriptId: z.string().uuid().optional().nullable(),
  })
  .superRefine(requireIdForRoutingMode);

export class UpsertPlatformPhoneRouteDto extends createZodDto(UpsertPlatformPhoneRouteSchema) {}
