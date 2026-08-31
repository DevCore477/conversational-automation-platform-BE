import { Injectable, Logger } from '@nestjs/common';

import { OpenAIClient } from '../../clients/openai/openai.client';
import { OpenAIModel } from '../../common/enums';
import { ConversationMessage } from '../types/call-state.types';
import { CallStateService } from './call-state.service';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly openaiClient: OpenAIClient,
    private readonly callStateService: CallStateService,
  ) {}

  async processUserMessage(callSid: string, userMessage: string): Promise<string> {
    try {
      const callState = this.callStateService.get(callSid);

      this.callStateService.addMessage(callSid, {
        role: 'user',
        content: userMessage,
      });

      this.logger.log(
        `Processing message for call ${callSid}: "${userMessage.substring(0, 50)}..."`,
      );

      const updatedCallState = this.callStateService.get(callSid);
      const messages = this.prepareMessages(updatedCallState.conversationHistory);

      const stream = await this.openaiClient.streamConversationChat(
        messages,
        callState.model as OpenAIModel,
        {
          temperature: 0.7,
          maxTokens: 1000,
        },
      );

      let fullResponse = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullResponse += delta;
        }
      }

      this.callStateService.addMessage(callSid, {
        role: 'assistant',
        content: fullResponse,
      });

      this.logger.log(
        `Generated response for call ${callSid}: "${fullResponse.substring(0, 50)}..."`,
      );

      return fullResponse;
    } catch (error) {
      this.logger.error(`Error processing message for call ${callSid}:`, error);
      throw error;
    }
  }

  private prepareMessages(
    conversationHistory: ConversationMessage[],
  ): { role: 'system' | 'user' | 'assistant'; content: string }[] {
    return conversationHistory.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  }
}
