import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

import { AgentsService } from '../../agents/agents.service';
import { isConversationFlowEngine, isScriptEngine } from '../../agents/types/response-engine.types';
import { normalizeConversationFlowMode } from '../../agents/types/conversation-flow-mode.types';
import { CallScriptService } from '../../call-scripts/call-script.service';
import {
  OpenAIClient,
  type ConversationMessageWithParts,
} from '../../clients/openai/openai.client';
import { OpenAIModel } from '../../common/enums';
import {
  WhatsAppMediaKind,
  WhatsAppMessageDirection,
  WhatsAppRoutingMode,
} from '../../common/enums/whatsapp.enum';
import { PromptConverter } from '../../common/utils/prompt-converter.util';
import { getEffectiveFlow, getStartNodeId } from '../../flows/flow-accessors';
import { buildFlowSystemPrompt } from '../../flows/flow-prompt.builder';
import { FlowRuntimeService } from '../../flows/flow-runtime.service';
import { FlowsService } from '../../flows/flows.service';
import type { WhatsAppMessageMedia } from '../../models/whatsapp/whatsapp-message-media.entity';
import type {
  WhatsAppConversation,
  WhatsAppSessionState,
} from '../../models/whatsapp/whatsapp-conversation.entity';
import type { ResolvedWhatsAppRouting } from './whatsapp-inbound-config.service';
import { isSessionRoutingStale } from '../utils/whatsapp-reply-routing.util';
import { WhatsAppChatService } from './whatsapp-chat.service';
import { WhatsAppContextBuilderService } from './whatsapp-context-builder.service';

@Injectable()
export class WhatsAppConversationEngineService {
  private readonly logger = new Logger(WhatsAppConversationEngineService.name);

  constructor(
    private readonly openaiClient: OpenAIClient,
    private readonly flowRuntime: FlowRuntimeService,
    private readonly flowsService: FlowsService,
    private readonly agentsService: AgentsService,
    private readonly callScriptService: CallScriptService,
    private readonly chatService: WhatsAppChatService,
    private readonly contextBuilder: WhatsAppContextBuilderService,
    private readonly configService: ConfigService,
  ) {}

  async initializeSession(
    conversation: WhatsAppConversation,
    routing: ResolvedWhatsAppRouting,
  ): Promise<WhatsAppSessionState> {
    const state: WhatsAppSessionState = {
      routingMode: routing.routingMode,
      agentId: routing.agentId ?? undefined,
      flowId: routing.flowId ?? undefined,
      scriptId: routing.scriptId ?? undefined,
      model: routing.aiModel,
      chatHistory: [],
    };

    if (routing.routingMode === WhatsAppRoutingMode.AGENT && routing.agentId) {
      return this.initFromAgent(conversation, routing.agentId, state);
    }
    if (routing.routingMode === WhatsAppRoutingMode.FLOW && routing.flowId) {
      return this.initFromFlow(conversation.id, conversation.companyId, routing.flowId, state);
    }
    if (routing.routingMode === WhatsAppRoutingMode.SCRIPT && routing.scriptId) {
      return this.initFromScript(conversation.id, routing.scriptId, state, routing.aiModel);
    }
    if (routing.routingMode === WhatsAppRoutingMode.DATABASE_DEFAULT) {
      return this.initFromDefaultInbound(
        conversation.id,
        conversation.companyId,
        state,
        routing.aiModel,
      );
    }

    state.systemPrompt =
      routing.aiSystemPrompt ??
      this.configService.get<string>('app.inboundCallScript') ??
      'You are a helpful AI assistant on WhatsApp.';
    state.model = routing.aiModel;
    await this.chatService.updateSessionState(conversation.id, state);
    return state;
  }

  async generateReply(
    conversation: WhatsAppConversation,
    userText: string,
    routing: ResolvedWhatsAppRouting,
    mediaRowId?: string,
  ): Promise<string> {
    let state: WhatsAppSessionState;
    if (
      !conversation.sessionState ||
      isSessionRoutingStale(conversation, conversation.sessionState)
    ) {
      state = await this.initializeSession(conversation, routing);
    } else {
      state = conversation.sessionState;
    }

    const currentMedia = mediaRowId ? await this.contextBuilder.getMediaByRowId(mediaRowId) : null;
    // Always combine the caption with the media analysis — a caption alone (e.g. "what is this?")
    // told the flow/model nothing about the image; the analysis must not be dropped just because
    // a caption happens to be present.
    const effectiveUserText = [
      userText.trim(),
      this.contextBuilder.describeCurrentMedia(currentMedia),
    ]
      .filter(Boolean)
      .join('\n\n');

    await this.seedMessageContext(
      conversation.id,
      state,
      effectiveUserText,
      currentMedia?.messageId,
    );

    if (state.flowState && state.flowId) {
      return this.replyWithFlow(conversation.id, state, effectiveUserText, currentMedia?.messageId);
    }

    return this.replyWithOpenAI(conversation.id, state, effectiveUserText, currentMedia);
  }

  async getGreetingIfNeeded(
    conversation: WhatsAppConversation,
    routing: ResolvedWhatsAppRouting,
  ): Promise<string | null> {
    if (!routing.sendGreetingOnFirstMessage) {
      return null;
    }
    const messages = await this.chatService.listMessages(conversation.id, 5);
    const hasOutbound = messages.some(m => m.direction === WhatsAppMessageDirection.OUTBOUND);
    if (hasOutbound) {
      return null;
    }

    let state = conversation.sessionState;
    if (!state?.routingMode) {
      state = await this.initializeSession(conversation, routing);
    }

    if (state.flowState && state.flowId) {
      const flowRow = await this.loadPublishedFlow(state.flowId, conversation.companyId);
      if (!flowRow) {
        return null;
      }
      const effective = getEffectiveFlow(flowRow.flow);
      return this.flowRuntime.buildFirstMessage(effective, state.flowState.slots ?? {}, undefined, {
        channel: 'whatsapp',
      });
    }

    if (state.systemPrompt) {
      return 'Hello! How can I help you today?';
    }

    return null;
  }

  private async initFromAgent(
    conversation: WhatsAppConversation,
    agentId: string,
    state: WhatsAppSessionState,
  ): Promise<WhatsAppSessionState> {
    const agent = await this.agentsService.getForCall(agentId, { requirePublished: true });
    const ids = this.agentsService.getResponseEngineIds(agent);
    state.agentId = agent.id;
    state.agentGlobalPrompt = agent.globalPrompt?.trim();
    state.conversationFlowMode = agent.conversationFlowMode;
    state.model = 'gpt-4o-mini';

    if (isConversationFlowEngine(agent.responseEngine) && ids.flowId) {
      return this.initFromFlow(
        conversation.id,
        agent.companyId ?? conversation.companyId,
        ids.flowId,
        state,
      );
    }
    if (isScriptEngine(agent.responseEngine) && ids.scriptId) {
      return this.initFromScript(conversation.id, ids.scriptId, state, state.model);
    }

    state.systemPrompt = [
      agent.globalPrompt?.trim(),
      'You are replying on WhatsApp. Keep messages short (under 500 characters when possible).',
    ]
      .filter(Boolean)
      .join('\n\n');
    await this.chatService.updateSessionState(conversation.id, state);
    return state;
  }

  private async loadPublishedFlow(flowId: string, companyId: string | null) {
    if (companyId) {
      try {
        const flows = await this.flowsService.getPublishedByCompany(companyId, flowId);
        return flows[0] ?? null;
      } catch {
        return this.flowsService.findPublishedFlowById(flowId);
      }
    }
    return this.flowsService.findPublishedFlowById(flowId);
  }

  private async initFromFlow(
    conversationId: string,
    companyId: string | null,
    flowId: string,
    state: WhatsAppSessionState,
  ): Promise<WhatsAppSessionState> {
    const flowRow = await this.loadPublishedFlow(flowId, companyId);

    if (!flowRow) {
      throw new Error(`Flow ${flowId} not found`);
    }

    const effective = getEffectiveFlow(flowRow.flow);
    const startId = getStartNodeId(effective);
    state.flowId = flowRow.id;
    state.routingMode ??= WhatsAppRoutingMode.FLOW;
    state.systemPrompt = buildFlowSystemPrompt({
      flow: effective,
      currentNodeId: startId,
      slots: {},
      mode: normalizeConversationFlowMode(state.conversationFlowMode),
      channel: 'whatsapp',
    });
    state.flowState = {
      currentNode: startId,
      slots: {},
      history: [],
    };
    state.model = 'gpt-4o-mini';
    await this.chatService.updateSessionState(conversationId, state);
    return state;
  }

  private async initFromScript(
    conversationId: string,
    scriptId: string,
    state: WhatsAppSessionState,
    model: string,
  ): Promise<WhatsAppSessionState> {
    const script = await this.callScriptService.findOne(scriptId);
    state.scriptId = script.id;
    state.systemPrompt = PromptConverter.autoConvert(script.script);
    state.model = script.model ?? model;
    state.chatHistory = [{ role: 'system', content: state.systemPrompt }];
    await this.chatService.updateSessionState(conversationId, state);
    return state;
  }

  private async initFromDefaultInbound(
    conversationId: string,
    companyId: string | null,
    state: WhatsAppSessionState,
    model: string,
  ): Promise<WhatsAppSessionState> {
    if (companyId) {
      const script = await this.callScriptService.findDefaultInboundByCompany(companyId);
      if (script) {
        return this.initFromScript(conversationId, script.id, state, model);
      }
    }
    state.systemPrompt =
      this.configService.get<string>('app.inboundCallScript') ??
      'You are a helpful AI assistant on WhatsApp.';
    state.model = model;
    state.chatHistory = [{ role: 'system', content: state.systemPrompt }];
    await this.chatService.updateSessionState(conversationId, state);
    return state;
  }

  private async replyWithFlow(
    conversationId: string,
    state: WhatsAppSessionState,
    userText: string,
    excludeMessageId?: string,
  ): Promise<string> {
    const conv = await this.chatService.getConversation(conversationId);
    const flowRow = await this.loadPublishedFlow(state.flowId!, conv?.companyId ?? null);
    if (!flowRow || !state.flowState) {
      return this.replyWithOpenAI(conversationId, state, userText);
    }

    const effective = getEffectiveFlow(flowRow.flow);
    const priorContext = await this.contextBuilder.buildFlowContextBlock({
      conversationId,
      currentQueryText: userText,
      excludeMessageId,
    });
    const agentContext = [state.agentGlobalPrompt, priorContext].filter(Boolean).join('\n\n');
    const toolExecutionContext = {
      conversationId,
      companyId: conv?.companyId ?? undefined,
      flowId: state.flowId,
      phoneNumberTo: conv?.contactPhone,
      channel: 'whatsapp' as const,
      slots: state.flowState.slots ?? {},
    };

    const result = await this.flowRuntime.advanceFlowTurn({
      flow: effective,
      state: state.flowState as Parameters<FlowRuntimeService['next']>[0]['state'],
      userTranscript: userText,
      agentConversationContext: agentContext || undefined,
      conversationFlowMode: normalizeConversationFlowMode(state.conversationFlowMode),
      toolExecutionContext,
      channel: 'whatsapp',
    });

    state.flowState = result.newState as WhatsAppSessionState['flowState'];
    await this.persistChatState(conversationId, state);

    return this.flowRuntime.resolveTurnReply({
      flow: effective,
      result,
      channel: 'whatsapp',
      agentConversationContext: agentContext || undefined,
      conversationFlowMode: normalizeConversationFlowMode(state.conversationFlowMode),
      toolExecutionContext,
    });
  }

  private async replyWithOpenAI(
    conversationId: string,
    state: WhatsAppSessionState,
    userText: string,
    currentMedia?: WhatsAppMessageMedia | null,
  ): Promise<string> {
    const history = state.chatHistory ?? [];
    if (history.length === 0 && state.systemPrompt) {
      history.push({ role: 'system', content: state.systemPrompt });
    }
    // Persisted history always stays plain text; the live image is attached only on the outgoing call.
    history.push({ role: 'user', content: userText || '[media message]' });

    const messages: ConversationMessageWithParts[] = history
      .slice(0, -1)
      .map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: this.buildCurrentTurnContent(userText, currentMedia) });

    const stream = await this.openaiClient.streamConversationChat(
      messages,
      (state.model ?? 'gpt-4o-mini') as OpenAIModel,
      { temperature: 0.7, maxTokens: 800 },
    );

    let full = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        full += delta;
      }
    }

    history.push({ role: 'assistant', content: full });
    state.chatHistory = history;
    await this.persistChatState(conversationId, state);

    return full.trim() || 'Thanks for your message.';
  }

  async persistChatState(conversationId: string, state: WhatsAppSessionState): Promise<void> {
    await this.chatService.updateSessionState(conversationId, state);
  }

  /** Attaches the live inbound image as real pixels (via its S3 URL) alongside any caption/text. */
  private buildCurrentTurnContent(
    userText: string,
    media?: WhatsAppMessageMedia | null,
  ): string | ChatCompletionContentPart[] {
    const isLiveImage =
      media?.s3Url &&
      (media.mediaType === WhatsAppMediaKind.IMAGE ||
        media.mediaType === WhatsAppMediaKind.STICKER);

    if (!isLiveImage) {
      return userText || '[media message]';
    }

    const parts: ChatCompletionContentPart[] = [];
    if (userText) {
      parts.push({ type: 'text', text: userText });
    }
    parts.push({ type: 'image_url', image_url: { url: media.s3Url! } });
    return parts;
  }

  private async seedMessageContext(
    conversationId: string,
    state: WhatsAppSessionState,
    currentQueryText?: string,
    excludeMessageId?: string,
  ): Promise<void> {
    const existing = state.chatHistory ?? [];
    const hasDialogue = existing.some(m => m.role === 'user' || m.role === 'assistant');
    if (hasDialogue) {
      return;
    }

    const seeded = await this.contextBuilder.buildChatHistorySeed({
      conversationId,
      currentQueryText,
      excludeMessageId,
    });
    if (seeded.length === 0) {
      return;
    }

    const history = [...existing];
    if (history.length === 0 && state.systemPrompt) {
      history.push({ role: 'system', content: state.systemPrompt });
    }
    state.chatHistory = [...history, ...seeded];
  }
}
