import { Logger } from '@nestjs/common';
import { Client, handle_file } from '@gradio/client';
import axios, { AxiosInstance } from 'axios';
import { existsSync } from 'fs';
import { resolve } from 'path';

import { wavBufferToPcm16kMono } from '../../common/utils/audio-codec.util';
import {
  ITTSClient,
  TTSConfig,
  TTSAudioChunk,
  VoiceInfo,
} from '../voice-client/voice-client.interface';

export type ChatterboxApiType = 'openai' | 'gradio';

export interface ChatterboxClientOptions {
  /** OpenAI-compatible `/v1/audio/speech` vs Gradio UI server (`@gradio/client`). */
  apiType?: ChatterboxApiType;
  /** Legacy / unused when using official JS client; kept for config compatibility. */
  gradioFnIndex?: number;
  /** Legacy; wrap_generate uses `handle_file` for reference audio. */
  gradioIncludeVoiceInput?: boolean;
  /**
   * Gradio named endpoint from "View API" (e.g. `wrap_generate` → calls `/wrap_generate`).
   * Default `wrap_generate` (Chatterbox Gradio UI).
   */
  gradioApiName?: string;
  /** Gradio "Language" label (e.g. English). Empty string = derive from `TTSConfig.language`. */
  gradioLangName?: string;
}

/**
 * TTS client for Chatterbox-style backends:
 * - **openai**: HTTP POST `/v1/audio/speech` (JSON body, WAV/arraybuffer response).
 * - **gradio**: `@gradio/client` (same protocol as the Gradio browser UI on e.g. :7860).
 */
export class ChatterboxTTSClient implements ITTSClient {
  private static readonly GRADIO_LANG_FROM_CODE: Record<string, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    ja: 'Japanese',
    zh: 'Chinese',
  };

  private readonly logger = new Logger(ChatterboxTTSClient.name);
  private readonly jsonClient: AxiosInstance;
  private readonly baseUrl: string;
  private readonly defaultVoicePath: string;
  private readonly apiType: ChatterboxApiType;
  /** e.g. `/wrap_generate` — passed to `client.predict()`. */
  private readonly gradioApiEndpoint: string;
  /** Fixed Gradio language label, or empty to derive from agent language. */
  private readonly gradioLangName: string;
  private gradioClientPromise: Promise<Client> | null = null;
  private isAborted = false;

  constructor(
    baseUrl = 'http://localhost:4123',
    defaultVoicePath?: string,
    options?: ChatterboxClientOptions,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultVoicePath = defaultVoicePath || './voice-sample.mp3';
    this.apiType = options?.apiType ?? 'openai';
    const slug =
      (options?.gradioApiName ?? 'wrap_generate').replace(/^\/+/, '').trim() || 'wrap_generate';
    this.gradioApiEndpoint = `/${slug}`;
    this.gradioLangName = options?.gradioLangName ?? '';

    this.jsonClient = axios.create({
      baseURL: this.baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 120_000,
    });

    this.logger.log(
      `Chatterbox TTS: apiType=${this.apiType}${
        this.apiType === 'gradio'
          ? `, gradio endpoint=${this.gradioApiEndpoint} (@gradio/client)`
          : ''
      }`,
    );
  }

  abort(): void {
    this.logger.log(`🛑 Aborting TTS stream`);
    this.isAborted = true;
  }

  isActive(): boolean {
    return false;
  }

  async streamTTS(
    config: TTSConfig,
    textIterator: AsyncIterable<string>,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
    onError?: (error: Error) => void,
  ): Promise<void> {
    let fullText = '';
    for await (const textChunk of textIterator) {
      fullText += textChunk;
    }

    if (this.isAborted) {
      throw new Error('TTS aborted');
    }

    try {
      if (this.apiType === 'gradio') {
        const wav = await this.generateSpeechRawWavGradio(fullText, config);
        const pcm16k = wavBufferToPcm16kMono(wav);
        if (pcm16k.length === 0) {
          this.logger.error(
            `Gradio WAV decoded to 0 PCM bytes (wav=${wav.length} B). Chatterbox often uses IEEE float WAV — ensure audio-codec supports it.`,
          );
        }
        await this.emitPcmChunks(pcm16k, onAudioChunk);
        await onAudioChunk({ audio: Buffer.alloc(0), isFinal: true });
        return;
      }

      const response = await this.jsonClient.post(
        '/v1/audio/speech',
        {
          input: fullText,
          voice: config.voiceId || this.defaultVoicePath,
          exaggeration: config.exaggeration ?? 0.5,
          cfg_weight: config.cfgWeight ?? 0.5,
          temperature: config.temperature ?? 0.8,
          response_format: 'wav',
          language: config.language || 'en',
          stream: true,
        },
        { responseType: 'stream' },
      );

      const stream = response.data;
      let buffer = Buffer.alloc(0);

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
        });

        stream.on('end', async () => {
          const wav = buffer.length > 0 ? buffer : Buffer.alloc(0);
          const pcm16k = wav.length > 0 ? wavBufferToPcm16kMono(wav) : Buffer.alloc(0);
          await this.emitPcmChunks(pcm16k, onAudioChunk);
          await onAudioChunk({ audio: Buffer.alloc(0), isFinal: true });
          resolve();
        });

        stream.on('error', (err: Error) => {
          if (onError) onError(err);
          reject(err);
        });
      });
    } catch (error) {
      this.logger.warn(`Streaming failed, using fallback: ${(error as Error).message}`);
      try {
        const wav = await this.generateSpeechRawWav(fullText, config);
        const pcm16k = wavBufferToPcm16kMono(wav);
        await this.emitPcmChunks(pcm16k, onAudioChunk);
        await onAudioChunk({ audio: Buffer.alloc(0), isFinal: true });
      } catch (fallbackError) {
        if (onError) onError(fallbackError as Error);
        throw fallbackError;
      }
    }
  }

  async generateSpeechRawWav(text: string, config: TTSConfig): Promise<Buffer> {
    if (this.apiType === 'gradio') {
      return this.generateSpeechRawWavGradio(text, config);
    }
    return this.generateSpeechRawWavOpenAI(text, config);
  }

  private async generateSpeechRawWavOpenAI(text: string, config: TTSConfig): Promise<Buffer> {
    this.logger.log(`🎤 OpenAI-style TTS: "${text.substring(0, 50)}..."`);

    const response = await this.jsonClient.post(
      '/v1/audio/speech',
      {
        input: text,
        voice: config.voiceId || this.defaultVoicePath,
        exaggeration: config.exaggeration ?? 0.5,
        cfg_weight: config.cfgWeight ?? 0.5,
        temperature: config.temperature ?? 0.8,
        response_format: 'wav',
        language: config.language || 'en',
      },
      { responseType: 'arraybuffer' },
    );

    const audioBuffer = Buffer.from(response.data as ArrayBuffer);
    this.logger.log(`✅ Generated ${audioBuffer.length} bytes of WAV`);
    return audioBuffer;
  }

  /**
   * Uses official `@gradio/client` (same as Gradio "View API" / API Recorder).
   * Chatterbox `/wrap_generate`: text, lang_name, voice (reference audio via `handle_file`), exag, stab.
   */
  private async getGradioClient(): Promise<Client> {
    if (!this.gradioClientPromise) {
      const url = `${this.baseUrl}/`;
      this.logger.log(`Gradio JS client connecting to ${url}`);
      this.gradioClientPromise = Client.connect(url);
    }
    return this.gradioClientPromise;
  }

  private resolveLangNameForGradio(config: TTSConfig): string {
    const fixed = this.gradioLangName.trim();
    if (fixed) return fixed;
    const code = (config.language ?? 'en').toLowerCase().split('-')[0] ?? 'en';
    return ChatterboxTTSClient.GRADIO_LANG_FROM_CODE[code] ?? 'English';
  }

  /**
   * Reference voice file on the API host (uploaded by `@gradio/client` to Gradio).
   * ElevenLabs voice IDs are ignored; `CHATTERBOX_DEFAULT_VOICE_PATH` is used instead.
   */
  private resolveReferenceVoicePath(config: TTSConfig): string {
    const vid = config.voiceId?.trim();
    const looksLikeFile =
      vid &&
      (vid.includes('/') ||
        vid.includes('\\') ||
        /\.(mp3|wav|m4a|ogg|flac)$/i.test(vid) ||
        vid.startsWith('.'));

    if (looksLikeFile) {
      const p = vid.startsWith('.') ? resolve(process.cwd(), vid) : resolve(vid);
      if (existsSync(p)) return p;
    }

    const rel = this.defaultVoicePath;
    const resolved =
      rel.startsWith('/') || /^[A-Za-z]:\\/.test(rel) ? resolve(rel) : resolve(process.cwd(), rel);
    if (!existsSync(resolved)) {
      throw new Error(
        `Gradio TTS: reference voice file not found (${resolved}). ` +
          `Chatterbox /wrap_generate requires a local audio file for cloning. Set CHATTERBOX_DEFAULT_VOICE_PATH.`,
      );
    }
    return resolved;
  }

  private async generateSpeechRawWavGradio(text: string, config: TTSConfig): Promise<Buffer> {
    this.logger.log(`🎤 Gradio TTS: "${text.substring(0, 50)}..."`);

    const client = await this.getGradioClient();
    const voicePath = this.resolveReferenceVoicePath(config);
    const langName = this.resolveLangNameForGradio(config);
    const exag = config.exaggeration ?? 0.5;
    const stab = config.cfgWeight ?? 0.5;

    try {
      const result = await client.predict(this.gradioApiEndpoint, {
        text,
        lang_name: langName,
        voice: handle_file(voicePath),
        exag,
        stab,
      });

      const wav = await this.wavFromGradioOutput(result.data);
      this.logger.log(`✅ Gradio TTS (${this.gradioApiEndpoint}): ${wav.length} bytes WAV`);
      return wav;
    } catch (e) {
      this.gradioClientPromise = null;
      throw e;
    }
  }

  private async wavFromGradioOutput(data: unknown): Promise<Buffer> {
    const first = this.unwrapGradioData(data);
    return this.resolveGradioFileValue(first);
  }

  private unwrapGradioData(data: unknown): unknown {
    if (data == null) {
      throw new Error('Gradio TTS: empty response data');
    }
    let x: unknown = data;
    while (Array.isArray(x) && x.length === 1) {
      x = x[0];
    }
    if (Array.isArray(x) && x.length > 0) {
      x = x[0];
    }
    return x;
  }

  private async resolveGradioFileValue(value: unknown): Promise<Buffer> {
    if (Buffer.isBuffer(value)) {
      return value;
    }

    if (typeof value === 'string') {
      if (value.startsWith('http://') || value.startsWith('https://')) {
        const r = await axios.get(value, { responseType: 'arraybuffer' });
        return Buffer.from(r.data as ArrayBuffer);
      }
      if (value.startsWith('data:')) {
        const base64 = value.split(',')[1];
        if (base64) return Buffer.from(base64, 'base64');
      }
      const fileUrl = `${this.baseUrl}/file=${encodeURIComponent(value)}`;
      const r = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      return Buffer.from(r.data as ArrayBuffer);
    }

    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o.url === 'string') {
        return this.resolveGradioFileValue(o.url);
      }
      if (typeof o.path === 'string') {
        return this.resolveGradioFileValue(o.path);
      }
      if (typeof o.data === 'string' && (o.is_file === true || typeof o.orig_name === 'string')) {
        const maybeB64 = o.data;
        if (maybeB64) return Buffer.from(maybeB64, 'base64');
      }
    }

    throw new Error(
      `Gradio TTS: could not parse audio output (got ${typeof value}). Check Gradio "View API" return shape.`,
    );
  }

  async generateSpeech(text: string, config: TTSConfig): Promise<Buffer> {
    const wav = await this.generateSpeechRawWav(text, config);
    return wavBufferToPcm16kMono(wav);
  }

  private async emitPcmChunks(
    pcm16k: Buffer,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
  ): Promise<void> {
    const chunkBytes = 3200;
    for (let i = 0; i < pcm16k.length; i += chunkBytes) {
      await onAudioChunk({
        audio: pcm16k.subarray(i, Math.min(i + chunkBytes, pcm16k.length)),
        isFinal: false,
      });
    }
  }

  async getVoices(): Promise<VoiceInfo[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/voices`);
      return (response.data || []).map((v: { name?: string; id?: string; language?: string }) => ({
        voice_id: v.name || v.id,
        name: v.name,
        language: v.language,
        isDefault: (v.name || v.id) === this.defaultVoicePath,
      }));
    } catch {
      return [
        {
          voice_id: this.defaultVoicePath,
          name: 'Default Voice',
          isDefault: true,
        },
      ];
    }
  }

  async healthCheck(): Promise<{ status: string; model_loaded?: boolean; device?: string }> {
    try {
      if (this.apiType === 'gradio') {
        const r = await axios.get(`${this.baseUrl}/`, { timeout: 5000 });
        return { status: r.status === 200 ? 'ok' : 'unhealthy' };
      }
      const response = await axios.get(`${this.baseUrl}/health`);
      return response.data;
    } catch {
      return { status: 'unhealthy' };
    }
  }
}
