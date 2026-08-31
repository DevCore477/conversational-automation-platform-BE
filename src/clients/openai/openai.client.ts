import OpenAI, { toFile } from 'openai';
import type { Stream } from 'openai/streaming';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { Logger } from '@nestjs/common';

import { ConversationMessage } from '../../calls/types/call-state.types';
import { OpenAIModel } from '../../common/enums';

/**
 * Like `ConversationMessage`, but content may also be multi-part (text + image_url) — used to
 * attach a live-turn image (e.g. WhatsApp inbound photo) alongside text history for vision-aware replies.
 */
export interface ConversationMessageWithParts {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatCompletionContentPart[];
}

export class OpenAIClient {
  private readonly logger = new Logger(OpenAIClient.name);
  private readonly client: OpenAI;
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  /**
   * Stream conversation chat - returns a stream of chat completion chunks
   * This is the primary method used for conversational calls
   */
  async streamConversationChat(
    messages: ConversationMessage[] | ConversationMessageWithParts[],
    model: OpenAIModel,
    options?: {
      temperature?: number;
      maxTokens?: number;
      /** Forwarded to the underlying request so `handleInterruption`'s `abort()` actually cancels
       * the in-flight OpenAI request, not just local bookkeeping. */
      signal?: AbortSignal;
    },
  ): Promise<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    const stream = await this.client.chat.completions.create(
      {
        model,
        messages: messages as ChatCompletionMessageParam[],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 1000,
        stream: true,
      },
      { signal: options?.signal },
    );

    return stream;
  }

  /**
   * Simple chat completion (non-streaming) - useful for extraction tasks
   */
  async chatCompletion(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    model: OpenAIModel = OpenAIModel.GPT_4O_MINI,
    options?: {
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature ?? 0.1,
      max_tokens: options?.maxTokens ?? 100,
      stream: false,
    });

    return response.choices[0]?.message?.content?.trim() || '';
  }

  /**
   * Non-streaming completion returning the full assistant message (including tool_calls when tools are provided).
   */
  async chatCompletionAssistantMessage(
    messages: ChatCompletionMessageParam[],
    model: OpenAIModel = OpenAIModel.GPT_4O_MINI,
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: ChatCompletionTool[];
      toolChoice?: 'auto' | 'none' | 'required';
    },
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> {
    const response = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature ?? 0.1,
      max_tokens: options?.maxTokens ?? 100,
      stream: false,
      ...(options?.tools?.length
        ? {
            tools: options.tools,
            tool_choice: options.toolChoice ?? 'auto',
          }
        : {}),
    });

    const msg = response.choices[0]?.message;
    if (!msg) {
      throw new Error('OpenAI chat completion returned no message');
    }
    return msg;
  }

  /**
   * Transcribe audio using Whisper API
   */
  async transcribeAudio(audioBuffer: Buffer): Promise<{ text: string }> {
    try {
      const wavBuffer = this.createWavFile(audioBuffer, 16000);
      const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });

      const response = await this.client.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'en',
      });

      return { text: response.text };
    } catch (error) {
      this.logger.error('❌ Whisper transcription error:', error);
      throw error;
    }
  }

  /**
   * Transcribe an audio file's raw bytes (e.g. WhatsApp voice notes/audio: ogg/opus, mp3, m4a).
   * Unlike `transcribeAudio`, this sends the bytes as-is — Whisper natively supports these
   * container formats, so no WAV re-encoding is needed.
   */
  async transcribeAudioFile(
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<{ text: string }> {
    const file = await toFile(buffer, filename, { type: mimeType });
    const response = await this.client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });
    return { text: response.text };
  }

  /**
   * Analyze an image with a vision-capable chat model. Returns a structured description
   * (best-effort JSON parse; falls back to putting the raw text in `description`).
   */
  async analyzeImage(
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
  ): Promise<{
    description: string;
    ocrText: string;
    objects: string[];
    entities: string[];
    summary: string;
  }> {
    const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
    const instructions = [
      'You are a vision analysis engine for a customer-support WhatsApp assistant.',
      'Analyze the attached image and respond with ONLY a JSON object (no markdown fences) with keys:',
      '"description" (detailed visual description), "ocrText" (any legible text in the image, empty string if none),',
      '"objects" (array of notable objects/subjects), "entities" (array of named entities/brands/identifiers visible),',
      '"summary" (one-sentence semantic summary).',
      caption ? `The user sent this caption along with the image: "${caption}"` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const response = await this.client.chat.completions.create({
      model: OpenAIModel.GPT_4O_MINI,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instructions },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 700,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    return this.parseVisionResult(raw);
  }

  private parseVisionResult(raw: string): {
    description: string;
    ocrText: string;
    objects: string[];
    entities: string[];
    summary: string;
  } {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          description: typeof parsed.description === 'string' ? parsed.description : raw,
          ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : '',
          objects: Array.isArray(parsed.objects) ? parsed.objects.map(String) : [],
          entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
          summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        };
      } catch (err) {
        this.logger.warn(`Vision result JSON parse failed, falling back to raw text: ${(err as Error).message}`);
      }
    }
    return { description: raw, ocrText: '', objects: [], entities: [], summary: raw };
  }

  /** Create an embedding vector for semantic retrieval (in-app cosine similarity, no pgvector). */
  async createEmbedding(text: string): Promise<{ embedding: number[]; model: string }> {
    const model = 'text-embedding-3-small';
    const trimmed = text.slice(0, 8000);
    const response = await this.client.embeddings.create({ model, input: trimmed || ' ' });
    return { embedding: response.data[0]?.embedding ?? [], model };
  }

  /**
   * Create WAV file header for PCM data
   */
  private createWavFile(pcmData: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);

    // RIFF chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(pcmData.length, 40);

    return Buffer.concat([header, pcmData]);
  }
}
