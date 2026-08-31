/**
 * One turn in a call transcript stored on {@link CallRecord.conversationTranscript}.
 */
export type CallTranscriptRole = 'user' | 'agent';

export interface CallTranscriptTurn {
  role: CallTranscriptRole;
  text: string;
  /** ISO 8601 when known */
  at?: string;
}
