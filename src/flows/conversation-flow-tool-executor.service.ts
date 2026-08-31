import { Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';

import { OpenAIClient } from '../clients/openai/openai.client';
import { OpenAIModel } from '../common/enums';
import { courierPackageDemoFlowToolHandler } from './flow-tools/courier-package-demo.tool';
import {
  appendOrderItemFlowToolHandler,
  submitFoodOrderFlowToolHandler,
} from './flow-tools/food-order.tool';
import { getWeatherFlowToolHandler } from './flow-tools/get-weather.tool';
import {
  createMozoAppendOrderItemFlowToolHandler,
  createMozoGetMenuFlowToolHandler,
  createMozoSubmitOrderFlowToolHandler,
} from './flow-tools/mozo-order.tool';
import type { ElevenLabsToolDefinition } from './types/flows.types';
import { MozoApiService } from '../mozo/services/mozo-api.service';

/** Context passed to every flow tool handler (slots, call metadata). */
export interface FlowToolExecutionContext {
  slots: Record<string, unknown>;
  companyId?: string;
  callSid?: string;
  conversationId?: string;
  phoneNumberTo?: string;
  phoneNumberFrom?: string;
  flowId?: string;
  language?: string;
  channel?: 'voice' | 'whatsapp';
  /** Available to tool handlers that need to normalize non-English slot values (e.g. a location
   * captured in Urdu/Hindi script) into the form an external API expects. Optional — handlers
   * must work without it. */
  openaiClient?: OpenAIClient;
}

export type FlowToolHandler = (
  args: Record<string, unknown>,
  ctx: FlowToolExecutionContext,
) => Promise<string> | string;

function toolDefsToOpenAiTools(
  defs: ElevenLabsToolDefinition[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return defs.map(d => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters as unknown as Record<string, unknown>,
    },
  }));
}

@Injectable()
export class ConversationFlowToolExecutorService {
  private readonly logger = new Logger(ConversationFlowToolExecutorService.name);
  private readonly handlers = new Map<string, FlowToolHandler>();

  constructor(private readonly mozoApiService: MozoApiService) {
    this.registerBuiltins();
  }

  /** Register a server-side handler for `executorKey` (or tool name when executorKey is omitted). */
  register(executorKey: string, handler: FlowToolHandler): void {
    this.handlers.set(executorKey.trim(), handler);
  }

  private registerBuiltins(): void {
    this.register('echo', args => JSON.stringify({ ok: true, echo: args }, null, 0));
    this.register('get_slots', (_args, ctx) => JSON.stringify({ slots: ctx.slots ?? {} }, null, 0));
    this.register('get_weather', getWeatherFlowToolHandler);
    this.register('track_package_demo', courierPackageDemoFlowToolHandler);
    this.register('courier_package_demo', courierPackageDemoFlowToolHandler);
    this.register('append_order_item', appendOrderItemFlowToolHandler);
    this.register('submit_food_order', submitFoodOrderFlowToolHandler);
    this.register('mozo_get_menu', createMozoGetMenuFlowToolHandler(this.mozoApiService));
    this.register(
      'mozo_append_order_item',
      createMozoAppendOrderItemFlowToolHandler(this.mozoApiService),
    );
    this.register('mozo_create_order', createMozoSubmitOrderFlowToolHandler(this.mozoApiService));
  }

  async execute(
    toolName: string,
    executorKey: string | undefined,
    args: Record<string, unknown>,
    ctx: FlowToolExecutionContext,
  ): Promise<string> {
    const key = (executorKey?.trim() ?? toolName).trim();
    const handler = this.handlers.get(key);
    if (!handler) {
      this.logger.warn(`No handler registered for flow tool "${toolName}" (executorKey="${key}")`);
      return JSON.stringify({
        error: 'unknown_tool',
        tool: toolName,
        executorKey: key,
        hint: 'Register a handler via ConversationFlowToolExecutorService.register()',
      });
    }
    try {
      return await Promise.resolve(handler(args, ctx));
    } catch (err) {
      this.logger.error(`Flow tool "${toolName}" failed:`, err);
      return JSON.stringify({
        error: 'execution_failed',
        tool: toolName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Calls the chat model with tools until the assistant returns a text reply (no tool_calls),
   * or max iterations is reached. Tool outputs are JSON strings attached as `role: tool` messages.
   */
  async runToolAugmentedChat(
    client: OpenAIClient,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    toolDefinitions: ElevenLabsToolDefinition[],
    context: FlowToolExecutionContext,
    options: {
      model: OpenAIModel;
      temperature?: number;
      maxTokens?: number;
      maxIterations?: number;
      /**
       * Invoked once, right before the first tool call is actually executed (i.e. only when the
       * model decided to call a tool — never fires on a turn that returns plain text immediately).
       * Lets callers speak an immediate filler ("Let me check that...") in parallel with tool
       * execution instead of the caller sitting in silence for the whole (potentially
       * multi-round-trip) tool chain.
       */
      onBeforeToolExecution?: () => void;
    },
  ): Promise<string> {
    if (toolDefinitions.length === 0) {
      throw new Error('runToolAugmentedChat requires at least one tool definition');
    }

    const tools = toolDefsToOpenAiTools(toolDefinitions);
    const byName = new Map(toolDefinitions.map(d => [d.name, d] as const));
    const maxIter = options.maxIterations ?? 8;
    const working = [...messages];
    let toolExecutionStarted = false;

    for (let i = 0; i < maxIter; i++) {
      const msg = await client.chatCompletionAssistantMessage(working, options.model, {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        tools,
        toolChoice: 'auto',
      });

      const toolCalls = msg.tool_calls;
      if (toolCalls?.length) {
        if (!toolExecutionStarted) {
          toolExecutionStarted = true;
          options.onBeforeToolExecution?.();
        }
        working.push(msg);
        for (const tc of toolCalls) {
          if (tc.type !== 'function') continue;
          const name = tc.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            this.logger.warn(`Invalid JSON arguments for tool ${name}`);
          }
          const def = byName.get(name);
          const content = await this.execute(name, def?.executorKey, args, context);
          this.logger.debug(
            `Flow tool ${name} → ${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`,
          );
          working.push({
            role: 'tool',
            tool_call_id: tc.id,
            content,
          });
        }
        continue;
      }

      const content = msg.content as string | unknown[] | null;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            part &&
            typeof part === 'object' &&
            'type' in part &&
            part.type === 'text' &&
            'text' in part
          ) {
            text += ((part as { text?: string }).text ?? '') satisfies string;
          }
        }
      }
      return text.trim();
    }

    this.logger.warn('Flow tool loop exceeded max iterations; returning empty reply');
    return '';
  }
}
