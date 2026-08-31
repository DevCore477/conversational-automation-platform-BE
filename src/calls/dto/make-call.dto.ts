import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { OpenAIModel } from '../../common/enums';

export const MakeCallSchema = z
  .object({
    to: z.string().min(1, 'Recipient number is required'),
    // Option 0: Use an agent (resolves to flow, script, or LLM from agent config)
    agentId: z.uuid('Invalid agent ID').optional(),
    // Option 1: Use a script from the database
    scriptId: z.uuid('Invalid script ID').optional(),
    // Option 2: Provide script and model directly (legacy support)
    script: z.string().optional(),
    model: z.enum(OpenAIModel).optional(),
    flowId: z.uuid('Invalid flow ID').optional(),
    // Optional: Override voice for this specific call
    voiceId: z.string().max(100, 'Voice ID must be less than 100 characters').optional(),
    // Optional: First thing the agent says (e.g. "Hello, this is Royal Transfer calling.")
    firstMessage: z.string().max(2000).optional(),
    // Optional: Agent language for ElevenLabs (e.g. "no" for Norwegian, "en" for English). Use "no" to test vet flow in Norwegian.
    language: z.string().max(10).optional(),
    // If true, call is ended automatically after first message (for one-way announcements).
    endCallAfterFirstMessage: z.boolean().optional(),
    // Optional booking ID (e.g. Royal Transfer). When call completes, used to mark information call sent.
    bookingId: z.uuid('Invalid booking ID').optional(),
    /** Trusted-origin anonymous callers: optional label stored on the call record for differentiation. */
    callerName: z.string().max(200).optional(),
    callerEmail: z.email().max(320).optional(),
  })
  .refine(
    data => {
      // Either agentId, scriptId, flowId, or (script + model) must be provided
      return !!(data.agentId ?? data.scriptId ?? data.flowId ?? (data.script && data.model));
    },
    {
      message:
        'Either agentId, scriptId, flowId, or both script and model must be provided for outbound calls',
    },
  );

export type MakeCallInput = z.infer<typeof MakeCallSchema>;

export class MakeCallDto extends createZodDto(MakeCallSchema) {}
