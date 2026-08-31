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

export const UpdateAgentSchema = z.object({
  agentName: z.string().min(1).max(255).optional(),
  /** When responseEngine is conversation-flow: rigid vs flex. */
  conversationFlowMode: z.enum(['rigid', 'flex']).optional(),
  globalPrompt: globalPromptSchema,
  companyId: z.uuid().optional().nullable(),
  channel: z.enum(['voice']).optional(),
  responseEngine: ResponseEngineSchema.optional(),
  language: z.string().max(20).optional(),
  voiceId: z.string().max(100).optional().nullable(),
  maxCallDurationMs: z.number().int().min(0).optional(),
  interruptionSensitivity: z.number().min(0).max(1).optional(),
  dataStorageSetting: z.string().max(50).optional(),
  userDtmfOptions: z.record(z.string(), z.unknown()).optional().nullable(),
  isPublished: z.boolean().optional(),
  postCallAnalysisModel: z.string().max(80).optional().nullable(),
});

export class UpdateAgentDto extends createZodDto(UpdateAgentSchema) {}
