import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ISTTClient, STTTranscript } from '../voice-client/voice-client.interface';

export interface WhisperConfig {
  modelSize?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
  languageCode?: string;
  audioFormat?: 'pcm_16000' | 'pcm_22050' | 'pcm_24000' | 'pcm_44100';
  serverUrl?: string;
  useLocalProcess?: boolean;
  openaiApiKey?: string;
}

/** 16 kHz mono PCM16: bytes per second */
const BYTES_PER_SEC_16K_MONO = 32000;
/** Minimum speech before we call Whisper (~1s) — shorter clips hallucinate badly */
const MIN_UTTERANCE_BYTES = 32000;
/** After this much audio with no pause, force a segment (~5s) so long utterances still transcribe */
const MAX_SEGMENT_BYTES = 160000;
/** Trailing silence (ms) = end of user phrase; tune for phone line noise */
const END_UTTERANCE_SILENCE_MS = 340;
/** RMS below this (int16) ≈ silence for 20ms frames */
const SILENCE_RMS_THRESHOLD = 850;
const FRAME_MS = 20;
const POLL_MS = 150;

function rmsInt16LeFrame(buf: Buffer): number {
  const n = Math.floor(buf.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

function frameBytesFor20ms(sampleRate: number): number {
  return (sampleRate * 2 * FRAME_MS) / 1000;
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw e;
    }
  }
}

export class WhisperSTTClient extends EventEmitter implements ISTTClient {
  private readonly logger = new Logger(WhisperSTTClient.name);
  private readonly config: WhisperConfig;
  private isConnected = false;
  /** Continuous PCM from Twilio; we cut on silence or max length */
  private pcmStream = Buffer.alloc(0);
  private bufferFlushInterval: NodeJS.Timeout | null = null;
  private sampleRate = 16000;
  private tempDir: string;
  private readonly apiBaseUrl: string;
  private processQueue: Promise<void> = Promise.resolve();

  constructor(config: WhisperConfig = {}) {
    super();
    this.config = {
      modelSize: 'base',
      audioFormat: 'pcm_16000',
      serverUrl: 'http://localhost:8000',
      useLocalProcess: false,
      ...config,
    };
    const useOpenAi = !!this.config.openaiApiKey?.trim();
    this.apiBaseUrl = useOpenAi
      ? 'https://api.openai.com'
      : this.config.serverUrl || 'http://localhost:8000';

    const rateMatch = /pcm_(\d+)/.exec(this.config.audioFormat ?? 'pcm_16000');
    if (rateMatch) this.sampleRate = parseInt(rateMatch[1], 10);

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    const useOpenAi = !!this.config.openaiApiKey?.trim();
    this.logger.log(
      useOpenAi
        ? '🔌 Initializing Whisper STT (OpenAI whisper-1 API, silence-segmented)'
        : `🔌 Initializing Whisper STT (self-hosted: ${this.apiBaseUrl})`,
    );

    if (useOpenAi) {
      this.isConnected = true;
      this.startBufferFlush();
      this.emit('ready');
      this.logger.log('✅ Whisper STT ready (OpenAI API — no local server)');
      return;
    }

    try {
      const response = await fetch(`${this.apiBaseUrl}/health`);
      if (!response.ok) throw new Error('Whisper server not healthy');

      this.isConnected = true;
      this.startBufferFlush();
      this.emit('ready');
      this.logger.log('✅ Whisper STT connected (self-hosted)');
    } catch (err) {
      this.logger.error('❌ Failed to connect to Whisper server:', err);
      this.emit('error', err);
    }
  }

  private languageForApi(): string | undefined {
    const raw = (this.config.languageCode || 'en').toLowerCase();
    if (raw === 'eng' || raw === 'english') return 'en';
    if (raw === 'nor' || raw === 'nob' || raw === 'nno' || raw === 'norwegian') return 'no';
    return raw.length <= 5 ? raw : undefined;
  }

  private startBufferFlush() {
    this.bufferFlushInterval = setInterval(() => {
      this.maybeFlushUtterance();
    }, POLL_MS);
  }

  private stopBufferFlush() {
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
    }
  }

  /** Bytes of low-energy audio at the end of `pcm` (trailing silence). */
  private trailingSilenceByteCount(pcm: Buffer): number {
    const fb = frameBytesFor20ms(this.sampleRate);
    if (pcm.length < fb) return 0;
    let silent = 0;
    for (let i = pcm.length; i >= fb; i -= fb) {
      const frame = pcm.subarray(i - fb, i);
      if (rmsInt16LeFrame(frame) < SILENCE_RMS_THRESHOLD) silent += fb;
      else break;
    }
    return silent;
  }

  /** Drop trailing silence frames for a cleaner WAV to Whisper */
  private trimTrailingSilence(pcm: Buffer): Buffer {
    const fb = frameBytesFor20ms(this.sampleRate);
    if (pcm.length < fb) return pcm;
    let end = pcm.length;
    while (end >= fb) {
      const frame = pcm.subarray(end - fb, end);
      if (rmsInt16LeFrame(frame) < SILENCE_RMS_THRESHOLD) end -= fb;
      else break;
    }
    return pcm.subarray(0, end);
  }

  /**
   * Cut one utterance: enough audio + pause at end, or forced max length.
   * Fixed-size chunks (e.g. 0.5s) make whisper-1 hallucinate random words.
   */
  private maybeFlushUtterance(): void {
    if (this.pcmStream.length === 0) return;

    const silenceBytes = this.trailingSilenceByteCount(this.pcmStream);
    const silenceMs = (silenceBytes / BYTES_PER_SEC_16K_MONO) * 1000;
    const longEnough = this.pcmStream.length >= MIN_UTTERANCE_BYTES;
    const pauseAtEnd = silenceMs >= END_UTTERANCE_SILENCE_MS;
    const forceSplit = this.pcmStream.length >= MAX_SEGMENT_BYTES;

    if (!longEnough) return;
    if (!pauseAtEnd && !forceSplit) return;

    let chunk: Buffer;
    if (forceSplit && !pauseAtEnd) {
      chunk = this.pcmStream.subarray(0, MAX_SEGMENT_BYTES);
      this.pcmStream = this.pcmStream.subarray(MAX_SEGMENT_BYTES);
    } else {
      chunk = this.pcmStream;
      this.pcmStream = Buffer.alloc(0);
    }

    const trimmed = this.trimTrailingSilence(chunk);
    if (trimmed.length < MIN_UTTERANCE_BYTES) {
      this.pcmStream = Buffer.concat([trimmed, this.pcmStream]);
      return;
    }

    const tempFile = path.join(
      this.tempDir,
      `audio-${Date.now()}-${randomBytes(4).toString('hex')}.wav`,
    );
    const wavBuffer = this.pcmToWav(trimmed, this.sampleRate);
    fs.writeFileSync(tempFile, wavBuffer);

    this.processQueue = this.processQueue
      .then(() => this.processAudioFile(tempFile))
      .catch(err => {
        this.logger.warn(`Whisper queue error: ${err instanceof Error ? err.message : err}`);
      });
  }

  sendAudio(pcmBuffer: Buffer) {
    if (!this.isConnected) {
      this.connect().catch(() => {});
      return;
    }
    this.pcmStream = Buffer.concat([this.pcmStream, pcmBuffer]);
    this.maybeFlushUtterance();
  }

  discardBufferedAudio(): void {
    this.pcmStream = Buffer.alloc(0);
  }

  private pcmToWav(pcmData: Buffer, sampleRate: number): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;

    const wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + pcmData.length, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(pcmData.length, 40);

    return Buffer.concat([wavHeader, pcmData]);
  }

  private async processAudioFile(filePath: string): Promise<void> {
    try {
      const formData = new FormData();
      const audioBlob = new Blob([fs.readFileSync(filePath)], { type: 'audio/wav' });
      formData.append('file', audioBlob, 'audio.wav');
      formData.append('model', 'whisper-1');
      const lang = this.languageForApi();
      if (lang) formData.append('language', lang);
      formData.append('temperature', '0');
      formData.append('response_format', 'json');

      const headers: Record<string, string> = {};
      if (this.config.openaiApiKey) {
        headers.Authorization = `Bearer ${this.config.openaiApiKey}`;
      }

      const response = await fetch(`${this.apiBaseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: formData,
      });

      const bodyText = await response.text().catch(() => '');

      if (!response.ok) {
        if (
          response.status === 400 &&
          (bodyText.includes('audio_too_short') || bodyText.includes('too short'))
        ) {
          this.logger.debug(`Whisper: skipped chunk below minimum duration`);
          safeUnlink(filePath);
          return;
        }
        throw new Error(`Whisper API error: ${response.status} ${bodyText.slice(0, 200)}`);
      }

      let result: { text?: string; language?: string };
      try {
        result = JSON.parse(bodyText) as { text?: string; language?: string };
      } catch {
        throw new Error(`Whisper API: invalid JSON`);
      }

      const rawText = result.text?.trim();
      if (!rawText) {
        safeUnlink(filePath);
        return;
      }

      this.emit('transcript', {
        text: rawText,
        isFinal: true,
        language: result.language || this.config.languageCode,
      } as STTTranscript);

      safeUnlink(filePath);
    } catch (error) {
      this.logger.error(`❌ STT processing error:`, error);
      safeUnlink(filePath);
    }
  }

  disconnect() {
    this.stopBufferFlush();
    this.isConnected = false;
    const tail = this.pcmStream;
    this.pcmStream = Buffer.alloc(0);

    this.processQueue = this.processQueue
      .then(async () => {
        if (tail.length >= MIN_UTTERANCE_BYTES) {
          const trimmed = this.trimTrailingSilence(tail);
          if (trimmed.length >= MIN_UTTERANCE_BYTES) {
            const tempFile = path.join(this.tempDir, `audio-${Date.now()}-disconnect.wav`);
            fs.writeFileSync(tempFile, this.pcmToWav(trimmed, this.sampleRate));
            await this.processAudioFile(tempFile);
          }
        }
      })
      .then(() => {
        try {
          fs.rmSync(this.tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }

  isReady(): boolean {
    return this.isConnected;
  }
}
