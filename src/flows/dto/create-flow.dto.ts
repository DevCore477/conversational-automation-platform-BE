// src/flows/dto/create-flow.dto.ts

import { ConversationFlowJSON } from '../types/flows.types';

export class CreateFlowDto {
  name: string;
  scriptId?: string | null;
  flow: ConversationFlowJSON;
}

// todo: add zod validation for the flow structure, including nodes and edges, to ensure the flow JSON is well-formed before processing. This will help catch errors early and provide clear feedback to users creating flows.

//
// import { createZodDto } from 'nestjs-zod';
// import { z } from 'zod';
//
//
//
// const BaseNode = z.object({
//   id: z.string(),
//   title: z.string().optional(),
//   position: z.any().optional(),
// });
//
// const SayNode = BaseNode.extend({
//   type: z.literal('say'),
//   say: z.object({
//     template: z.string().optional(),
//     prompt: z.string().optional(),
//   }),
// });
//
// const ListenNode = BaseNode.extend({
//   type: z.literal('listen'),
//   listen: z.object({
//     capture_slot: z.string().optional(),
//     next: z.string().optional(),
//     intent_scope: z.array(z.string()).optional(),
//     fallback: z.string().optional(),
//   }),
// });
//
// const TransferCallNode = BaseNode.extend({
//   type: z.literal('transfer_call'),
//   name: z.string(),
//   transfer_destination: z.string(),
//   edge: z.string(),
// });
//
// const ToolNode = BaseNode.extend({
//   type: z.literal('tool'),
//   tool: z.object({
//     name: z.string(),
//     payload: z.any().optional(),
//   }),
// });
//
// const FlowNodeSchema = z.discriminatedUnion('type', [
//   SayNode,
//   ListenNode,
//   TransferCallNode,
//   ToolNode,
// ]);
//
// export const CreateFlowSchema = z.object({
//   name: z
//     .string()
//     .min(3, 'Flow name must be at least 3 characters')
//     .max(100, 'Flow name must be less than 100 characters'),
//   scriptId: z.string().optional().nullable(),
//   flow: z.object({
//     nodes: z.array(FlowNodeSchema),
//     start_node_id: z.string(),
//     // intents: z
//     //   .record(
//     //     z.string(),
//     //     z.object({
//     //       rules: z.array(z.string()),
//     //     }),
//     //   )
//     //   .optional(),
//     // tools: z
//     //   .array(
//     //     z.object({
//     //       name: z.string(),
//     //       description: z.string(),
//     //       parameters: z.object({
//     //         type: z.literal('object'),
//     //         properties: z.record(z.string(), z.any()),
//     //       }),
//     //     }),
//     //   )
//     //   .optional(),
//     conversation_flow_id: z.string().optional(), // For backward compatibility with legacy flows that may have this field at the top level
//     version: z.number().optional(), // Optional version field for future use
//     global_prompt: z.string().optional(), // Optional global prompts for the flow
//     start_speaker: z.string().optional(),
//     model_choice: z
//       .object({
//         type: z.string().optional(), // e.g., 'fixed', 'dynamic', etc.
//         model: z.string().optional(), // Required if type is 'fixed'
//       })
//       .optional(),
//     begin_tag_display_position: z
//       .object({
//         x: z.number(),
//         y: z.number(),
//       })
//       .optional(),
//     is_published: z.boolean().optional(),
//     intents: z
//       .record(
//         z.string(),
//         z
//           .object({
//             rules: z.array(z.string()),
//           })
//           .optional(),
//       )
//       .optional(),
//     tools: z
//       .array(
//         z.object({
//           name: z.string(),
//           description: z.string(),
//           parameters: z.object({
//             type: z.literal('object'),
//             properties: z.record(z.string(), z.any()),
//             required: z.string().optional(),
//           }),
//           executorKey: z.string().optional(),
//         }),
//       )
//       .optional(),
//   }),
// });
//
// export class CreateFlowDto extends createZodDto(CreateFlowSchema) {}
