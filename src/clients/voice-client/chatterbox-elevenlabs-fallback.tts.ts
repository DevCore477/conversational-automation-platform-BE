import { Logger } from '@nestjs/common';
import axios from 'axios';

import { ChatterboxTTSClient } from '../chatterbox/chatterbox.client';
import { ElevenLabsTTSAdapter } from './elevenlabs-tts.adapter';
import { ITTSClient, TTSConfig, TTSAudioChunk, VoiceInfo } from './voice-client.interface';
import {
  metadataToCanonicalIso6391,
  resolveElevenLabsTtsModelId,
} from '../../voice/call-language';

/**
 * Local dev: try Chatterbox first; if the server is down (ECONNREFUSED, etc.), use ElevenLabs TTS.
 * Maps Chatterbox-style voice paths to ElevenLabs default voice when falling back.
 */
export class ChatterboxWithElevenLabsFallbackTTS implements ITTSClient {
  constructor(
    private readonly chatterbox: ChatterboxTTSClient,
    private readonly elevenlabs: ElevenLabsTTSAdapter,
    private readonly logger: Logger,
    private readonly defaultElevenLabsVoiceId: string,
  ) {}

  /** Chatterbox wrong route (404), server errors, or network failure → use ElevenLabs. */
  private shouldFallbackToElevenLabs(err: unknown): boolean {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status != null && status >= 400) {
        return true;
      }
      const code = err.code;
      if (
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' ||
        code === 'EHOSTUNREACH'
      ) {
        return true;
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|status code 404|404/i.test(msg);
  }

  /** Chatterbox uses paths; ElevenLabs needs a voice_id. */
  private toElevenLabsConfig(config: TTSConfig): TTSConfig {
    const v = (config.voiceId || '').trim();
    const looksLikePath =
      v.includes('/') ||
      v.includes('\\') ||
      v.endsWith('.mp3') ||
      v.endsWith('.wav') ||
      v.startsWith('.') ||
      v.length < 8;
    const voiceId = looksLikePath || !v ? this.defaultElevenLabsVoiceId : v;
    const lang = metadataToCanonicalIso6391(config.language);
    const modelId = resolveElevenLabsTtsModelId(lang, { explicitModelId: config.modelId });
    return {
      ...config,
      voiceId,
      modelId,
      outputFormat: 'pcm_16000',
      stability: config.stability ?? 0.5,
      similarityBoost: config.similarityBoost ?? 0.8,
      speed: config.speed ?? 1.0,
    };
  }

  async streamTTS(
    config: TTSConfig,
    textIterator: AsyncIterable<string>,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
    onError?: (error: Error) => void,
  ): Promise<void> {
    let fullText = '';
    for await (const t of textIterator) {
      fullText += t;
    }
    const once = async function* () {
      yield fullText;
    };

    try {
      await this.chatterbox.streamTTS(config, once(), onAudioChunk, onError);
    } catch (err) {
      if (!this.shouldFallbackToElevenLabs(err)) {
        throw err;
      }
      this.logger.warn(
        `Chatterbox TTS failed (${err instanceof Error ? err.message : String(err)}); using ElevenLabs`,
      );
      const elConfig = this.toElevenLabsConfig(config);
      const again = async function* () {
        yield fullText;
      };
      await this.elevenlabs.streamTTS(elConfig, again(), onAudioChunk, onError);
    }
  }

  async generateSpeech(text: string, config: TTSConfig): Promise<Buffer> {
    try {
      return await this.chatterbox.generateSpeech(text, config);
    } catch (err) {
      if (!this.shouldFallbackToElevenLabs(err)) {
        throw err;
      }
      this.logger.warn(
        `Chatterbox TTS failed (${err instanceof Error ? err.message : String(err)}); using ElevenLabs`,
      );
      return this.elevenlabs.generateSpeech(text, this.toElevenLabsConfig(config));
    }
  }

  abort(): void {
    this.chatterbox.abort();
    this.elevenlabs.abort();
  }

  isActive(): boolean {
    return this.chatterbox.isActive() || this.elevenlabs.isActive();
  }

  async getVoices(): Promise<VoiceInfo[]> {
    return this.chatterbox.getVoices().catch(() => this.elevenlabs.getVoices());
  }

  async healthCheck(): Promise<{ status: string }> {
    return (
      this.chatterbox.healthCheck?.().catch(() => ({ status: 'unhealthy' })) ?? {
        status: 'unknown',
      }
    );
  }
}
