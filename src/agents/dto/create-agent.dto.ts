import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const ResponseEngineConversationFlowSchema = z.object({
  type: z.literal('conversation-flow'),
  version: z.number().optional(),
  conversation_flow_id: z.uuid(),
  conversation_flow_ids: z.array(z.uuid()).optional(),
});

const ResponseEngineScriptSchema = z.object({
  type: z.literal('script'),
  version: z.number().optional(),
  script_id: z.uuid(),
});

const ResponseEngineLlmSchema = z.object({
  type: z.literal('llm'),
  version: z.number().optional(),
  llm_id: z.string().min(1),
});

const ResponseEngineSchema = z.discriminatedUnion('type', [
  ResponseEngineConversationFlowSchema,
  ResponseEngineScriptSchema,
  ResponseEngineLlmSchema,
]);

const globalPromptSchema = z
  .string()
  .max(12000, 'Global prompt must be at most 12000 characters')
  .optional()
  .nullable();

export const CreateAgentSchema = z.object({
  agentName: z.string().min(1).max(255),
  globalPrompt: globalPromptSchema,
  companyId: z.uuid().optional().nullable(),
  channel: z.enum(['voice']).default('voice'),
  /** When responseEngine is conversation-flow: rigid (strict steps) vs flex (shared flow context). Defaults to rigid. */
  conversationFlowMode: z.enum(['rigid', 'flex']).default('rigid'),
  responseEngine: ResponseEngineSchema,
  language: z.string().max(20).default('en-US'),
  voiceId: z.string().max(100).optional().nullable(),
  maxCallDurationMs: z.number().int().min(0).default(300000),
  interruptionSensitivity: z.number().min(0).max(1).default(0.9),
  dataStorageSetting: z.string().max(50).default('everything'),
  userDtmfOptions: z.record(z.string(), z.unknown()).optional().nullable(),
  isPublished: z.boolean().default(false),
  postCallAnalysisModel: z.string().max(80).optional().nullable(),
});

export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;

export class CreateAgentDto extends createZodDto(CreateAgentSchema) {}
