import { z } from 'zod';

import { WhatsAppRoutingMode } from '../../common/enums/whatsapp.enum';

/** Shared field defs — spread into z.object() to avoid Zod 4 merge type issues. */
export const whatsAppReplyRoutingShape = {
  routingMode: z
    .enum([
      WhatsAppRoutingMode.AGENT,
      WhatsAppRoutingMode.FLOW,
      WhatsAppRoutingMode.SCRIPT,
      WhatsAppRoutingMode.AI,
      WhatsAppRoutingMode.DATABASE_DEFAULT,
    ])
    .optional(),
  agentId: z.string().uuid().optional().nullable(),
  flowId: z.string().uuid().optional().nullable(),
  scriptId: z.string().uuid().optional().nullable(),
  aiModel: z.string().min(1).max(64).optional(),
  aiSystemPrompt: z.string().max(16000).optional().nullable(),
} as const;

export const WhatsAppReplyRoutingFieldsSchema = z.object(whatsAppReplyRoutingShape);

export const WhatsAppReplyRoutingSchema = WhatsAppReplyRoutingFieldsSchema.refine(
  data => {
    if (!data.routingMode) {
      return true;
    }
    switch (data.routingMode) {
      case WhatsAppRoutingMode.AGENT:
        return Boolean(data.agentId);
      case WhatsAppRoutingMode.FLOW:
        return Boolean(data.flowId);
      case WhatsAppRoutingMode.SCRIPT:
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

export type WhatsAppReplyRoutingInput = z.infer<typeof WhatsAppReplyRoutingSchema>;

const replyRoutingModeRefine = (data: {
  routingMode?: string;
  agentId?: string | null | undefined;
  flowId?: string | null | undefined;
  scriptId?: string | null | undefined;
}): boolean => {
  if (!data.routingMode) {
    return true;
  }
  switch (data.routingMode) {
    case WhatsAppRoutingMode.AGENT:
      return Boolean(data.agentId);
    case WhatsAppRoutingMode.FLOW:
      return Boolean(data.flowId);
    case WhatsAppRoutingMode.SCRIPT:
      return Boolean(data.scriptId);
    default:
      return true;
  }
};

export const REPLY_ROUTING_REFINE_MESSAGE =
  'agentId is required for agent routing, flowId for flow routing, scriptId for script routing';

/** Append reply-routing fields to a shape, then wrap in z.object (Zod 4-safe). */
export function withReplyRoutingShape<T extends z.ZodRawShape>(shape: T) {
  return { ...shape, ...whatsAppReplyRoutingShape };
}

/** Build schema with reply-routing fields and routing-mode validation refine. */
export function withReplyRoutingFields<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(withReplyRoutingShape(shape))
    .refine(
      data => replyRoutingModeRefine(data as z.infer<typeof WhatsAppReplyRoutingFieldsSchema>),
      { message: REPLY_ROUTING_REFINE_MESSAGE },
    );
}

export type WhatsAppReplyRoutingFields = z.infer<typeof WhatsAppReplyRoutingFieldsSchema>;

export interface WhatsAppReplyRoutingConfig {
  routingMode: WhatsAppRoutingMode;
  agentId?: string | null;
  flowId?: string | null;
  scriptId?: string | null;
  aiModel?: string;
  aiSystemPrompt?: string | null;
}
