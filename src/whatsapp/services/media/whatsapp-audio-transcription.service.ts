import { Injectable, Logger } from '@nestjs/common';

import { OpenAIClient } from '../../../clients/openai/openai.client';

/** Thin, testable wrapper around Whisper transcription for voice notes/audio and extracted video audio. */
@Injectable()
export class WhatsAppAudioTranscriptionService {
  private readonly logger = new Logger(WhatsAppAudioTranscriptionService.name);

  constructor(private readonly openaiClient: OpenAIClient) {}

  async transcribe(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
    try {
      const { text } = await this.openaiClient.transcribeAudioFile(buffer, filename, mimeType);
      return text.trim();
    } catch (err) {
      this.logger.error(`Audio transcription failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
