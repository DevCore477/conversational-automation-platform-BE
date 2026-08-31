import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface ElevenLabsSTTConfig {
  modelId?: string;
  languageCode?: string;
  /** Bias Scribe toward menu terms, brand names, etc. (max 50 terms, 20 chars each). */
  keyterms?: string[];
  /** Include detected language on committed transcripts. */
  includeLanguageDetection?: boolean;
  enableAutomaticLanguageDetection?: boolean;
  audioFormat?: 'pcm_16000' | 'pcm_22050' | 'pcm_24000' | 'pcm_44100';
  includeTimestamps?: boolean;
  // VAD options for server-side VAD
  serverVad?: {
    vadThreshold?: number;
    vadSilenceThresholdSecs?: number;
    minSpeechDurationMs?: number;
    minSilenceDurationMs?: number;
  };
}

export interface STTTranscript {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
  words?: {
    text: string;
    start: number;
    end: number;
  }[];
}

export class ElevenLabsSTTClient extends EventEmitter {
  private readonly logger = new Logger(ElevenLabsSTTClient.name);
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private config: ElevenLabsSTTConfig;
  private isConnected = false;
  private audioBuffer: Buffer[] = [];
  private bufferFlushInterval: NodeJS.Timeout | null = null;
  private readonly BUFFER_SIZE = 4096; // Send audio in chunks
  private sampleRate = 16000;

  constructor(apiKey: string, config: ElevenLabsSTTConfig = {}) {
    super();
    this.apiKey = apiKey;
    this.config = {
      modelId: 'scribe_v2_realtime',
      audioFormat: 'pcm_16000',
      includeTimestamps: false,
      ...config,
    };

    // Extract sample rate from audio format - safe access
    const audioFormat = this.config.audioFormat ?? 'pcm_16000';
    const rateMatch = /pcm_(\d+)/.exec(audioFormat);
    if (rateMatch) {
      this.sampleRate = parseInt(rateMatch[1], 10);
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    // Build query parameters
    const params = new URLSearchParams();
    params.append('model_id', this.config.modelId || 'scribe_v2_realtime');
    params.append('encoding', this.config.audioFormat || 'pcm_16000');

    // Use VAD commit strategy if serverVad is configured, otherwise manual
    const commitStrategy = this.config.serverVad ? 'vad' : 'manual';
    params.append('commit_strategy', commitStrategy);

    const autoLang =
      this.config.enableAutomaticLanguageDetection === true ||
      this.config.includeLanguageDetection === true;
    if (this.config.languageCode && !autoLang) {
      params.append('language_code', this.config.languageCode);
    }

    if (this.config.includeLanguageDetection) {
      params.append('include_language_detection', 'true');
    }

    const keyterms = (this.config.keyterms ?? [])
      .map(t => t.trim())
      .filter(t => t.length > 0 && t.length <= 20)
      .slice(0, 50);
    for (const term of keyterms) {
      params.append('keyterms', term);
    }

    if (this.config.includeTimestamps) {
      params.append('include_timestamps', 'true');
    }

    // Add VAD parameters if using server VAD
    if (this.config.serverVad) {
      if (this.config.serverVad.vadThreshold !== undefined) {
        params.append('vad_threshold', this.config.serverVad.vadThreshold.toString());
      }
      if (this.config.serverVad.vadSilenceThresholdSecs !== undefined) {
        params.append(
          'vad_silence_threshold_secs',
          this.config.serverVad.vadSilenceThresholdSecs.toString(),
        );
      }
      if (this.config.serverVad.minSpeechDurationMs !== undefined) {
        params.append(
          'min_speech_duration_ms',
          this.config.serverVad.minSpeechDurationMs.toString(),
        );
      }
      if (this.config.serverVad.minSilenceDurationMs !== undefined) {
        params.append(
          'min_silence_duration_ms',
          this.config.serverVad.minSilenceDurationMs.toString(),
        );
      }
    }

    const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

    return new Promise((resolve, reject) => {
      this.logger.log(`🔌 Connecting to ElevenLabs STT: ${url}`);

      this.ws = new WebSocket(url, {
        headers: {
          'xi-api-key': this.apiKey,
        },
      });

      this.ws.on('open', () => {
        this.logger.log('✅ ElevenLabs STT WebSocket connected');
        this.isConnected = true;

        // Start buffer flush interval
        this.startBufferFlush();

        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (err) {
          this.logger.error('❌ Failed to parse STT message:', err);
          this.logger.debug('Raw message:', data.toString().substring(0, 200));
        }
      });

      this.ws.on('error', err => {
        this.logger.error('❌ ElevenLabs STT WebSocket error:', err);
        if (!this.isConnected) {
          reject(err);
        }
        this.emit('error', err);
      });

      this.ws.on('close', (code, reason) => {
        this.logger.log(`🔌 ElevenLabs STT WebSocket closed: ${code} - ${reason}`);
        this.isConnected = false;
        this.stopBufferFlush();
        this.emit('close');
      });
    });
  }

  private startBufferFlush() {
    // Flush audio buffer every 100ms to ensure smooth streaming
    this.bufferFlushInterval = setInterval(() => {
      this.flushAudioBuffer();
    }, 100);
  }

  private stopBufferFlush() {
    if (this.bufferFlushInterval) {
      clearInterval(this.bufferFlushInterval);
      this.bufferFlushInterval = null;
    }
  }

  discardBufferedAudio(): void {
    this.audioBuffer = [];
  }

  sendAudio(pcmBuffer: Buffer) {
    if (!this.isConnected || !this.ws) {
      // Buffer audio until connected
      return;
    }

    // Accumulate audio in buffer
    this.audioBuffer.push(pcmBuffer);
    const totalLength = this.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);

    // Flush if buffer is large enough
    if (totalLength >= this.BUFFER_SIZE) {
      this.flushAudioBuffer();
    }
  }

  private flushAudioBuffer() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.audioBuffer.length === 0) {
      return;
    }

    const combined = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];

    // Convert to base64 and send
    const base64Audio = combined.toString('base64');
    this.ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64Audio,
        sample_rate: this.sampleRate,
      }),
    );
  }

  /**
   * Manually commit the current transcript segment
   * Use this when you detect silence or end of speech
   */
  commit() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        message_type: 'commit',
      }),
    );
  }

  private handleMessage(message: any) {
    // ElevenLabs uses message_type (with underscore) not type
    const messageType = message.message_type || message.type;

    if (!messageType) {
      this.logger.debug('📨 Received message without type:', Object.keys(message));
      return;
    }

    switch (messageType) {
      case 'session_started':
        this.logger.log(`✅ STT Session started: ${message.session_id || 'unknown'}`);
        this.emit('ready');
        break;

      case 'partial_transcript':
        // Real-time partial results (not final)
        if (message.text) {
          this.emit('partial', {
            text: message.text,
            isFinal: false,
            language: message.language,
          } as STTTranscript);
        }
        break;

      case 'committed_transcript':
        // Final committed transcript (without timestamps)
        if (message.text) {
          this.emit('transcript', {
            text: message.text,
            isFinal: true,
            language: message.language,
          } as STTTranscript);
        } else {
          // Empty commit signals end of speech
          this.emit('silence');
        }
        break;

      case 'committed_transcript_with_timestamps':
        // Final committed transcript with word-level timestamps
        if (message.text) {
          this.emit('transcript', {
            text: message.text,
            isFinal: true,
            language: message.language,
            words: message.words,
          } as STTTranscript);
        } else {
          this.emit('silence');
        }
        break;

      case 'end_of_stream':
        // Server may send this when stream ends; treat as normal shutdown, not error
        this.logger.debug('📨 STT stream ended (end_of_stream)');
        break;

      case 'auth_error':
      case 'quota_exceeded':
      case 'transcriber_error':
      case 'input_error':
      case 'error':
        const errorMsg = message.message || message.error || 'Unknown error';
        const errorDetails = message.details || '';
        this.logger.error(`❌ ElevenLabs STT error [${messageType}]: ${errorMsg} ${errorDetails}`);
        this.emit('error', new Error(`${messageType}: ${errorMsg}`));
        break;

      default:
        this.logger.debug(`📨 Unknown STT message type: ${messageType}`, message);
    }
  }

  disconnect() {
    this.stopBufferFlush();

    // Flush remaining audio
    if (this.audioBuffer.length > 0) {
      this.flushAudioBuffer();
    }

    // ElevenLabs STT API does not use client-sent end_of_stream; sending it causes input_error.
    // Just close the WebSocket.

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  isReady(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}
