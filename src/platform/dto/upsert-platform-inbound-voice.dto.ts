import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RoutingMode = z.enum(['agent', 'flow', 'script', 'database_default']);

/** Shared by both the legacy single-row DTO and the per-phone-number route DTO. */
export function requireIdForRoutingMode(
  data: {
    routingMode: z.infer<typeof RoutingMode>;
    agentId?: string | null;
    flowId?: string | null;
    scriptId?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.routingMode === 'agent' && !data.agentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'agentId is required when routingMode is agent',
      path: ['agentId'],
    });
  }
  if (data.routingMode === 'flow' && !data.flowId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'flowId is required when routingMode is flow',
      path: ['flowId'],
    });
  }
  if (data.routingMode === 'script' && !data.scriptId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scriptId is required when routingMode is script',
      path: ['scriptId'],
    });
  }
}

export const UpsertPlatformInboundVoiceSchema = z
  .object({
    /** Omit or null for global/default platform routing (no tenant scope). */
    platformCompanyId: z.string().uuid('platformCompanyId must be a UUID').optional().nullable(),
    routingMode: RoutingMode,
    agentId: z.string().uuid().optional().nullable(),
    flowId: z.string().uuid().optional().nullable(),
    scriptId: z.string().uuid().optional().nullable(),
  })
  .superRefine(requireIdForRoutingMode);

export class UpsertPlatformInboundVoiceDto extends createZodDto(UpsertPlatformInboundVoiceSchema) {}
