// src/flows/dto/update-flow.dto.ts
import { ConversationFlowJSON } from '../types/flows.types';

export class UpdateFlowDto {
  flow: ConversationFlowJSON;
  /** Optional rename — omit to leave the flow's name unchanged. */
  name?: string;
}
