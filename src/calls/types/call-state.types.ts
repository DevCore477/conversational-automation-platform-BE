export enum CallStatus {
  INITIATING = 'initiating',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

export interface CallState {
  callSid: string;
  status: CallStatus;
  phoneNumberFrom: string;
  phoneNumberTo: string;
  script: string; // System prompt
  model: string; // OpenAI model to use
  voiceId?: string; // ElevenLabs voice ID
  conversationHistory: ConversationMessage[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  companyId?: string;
}

export interface CreateCallStateDto {
  callSid: string;
  phoneNumberFrom: string;
  phoneNumberTo: string;
  script: string;
  model: string;
  voiceId?: string;
  provider: string;
  metadata?: Record<string, unknown>;
  status: string;
  companyId?: string;
}
