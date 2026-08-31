/**
 * Unified interface for TTS (Text-to-Speech) clients
 * Works with both ElevenLabs (cloud) and Chatterbox (local)
 */
export interface ITTSClient {
  streamTTS(
    config: TTSConfig,
    textIterator: AsyncIterable<string>,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
    onError?: (error: Error) => void,
  ): Promise<void>;

  generateSpeech(text: string, config: TTSConfig): Promise<Buffer>;
  abort(): void;
  isActive(): boolean;
  getVoices(): Promise<VoiceInfo[]>;
  healthCheck?(): Promise<{ status: string }>;
  /**
   * Open and initialize the next TTS connection ahead of need (e.g. while waiting on STT/LLM
   * between turns), so the connection handshake doesn't block the start of the next reply.
   * Optional, best-effort — implementations without persistent connections can omit it.
   */
  prewarm?(config: TTSConfig): void;
}

/**
 * Unified interface for STT (Speech-to-Text) clients
 * Works with both ElevenLabs (cloud) and Whisper (local)
 */
export interface ISTTClient {
  connect(): Promise<void>;
  disconnect(): void;
  sendAudio(pcmBuffer: Buffer): void;
  isReady(): boolean;
  /** Drop queued PCM (e.g. after TTS ends) so echo is not transcribed. Optional. */
  discardBufferedAudio?(): void;

  // Event-based interface (implemented via EventEmitter)
  on(event: 'transcript', listener: (transcript: STTTranscript) => void): this;
  on(event: 'partial', listener: (transcript: STTTranscript) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'silence', listener: () => void): this;
}

export interface TTSConfig {
  voiceId: string;
  modelId?: string;
  outputFormat?:
    | 'mp3_44100'
    | 'pcm_16000'
    | 'pcm_22050'
    | 'pcm_24000'
    | 'pcm_44100'
    | 'wav'
    | 'mp3';
  // ElevenLabs specific (ignored by Chatterbox)
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
  // Chatterbox specific (ignored by ElevenLabs)
  exaggeration?: number;
  cfgWeight?: number;
  temperature?: number;
  language?: string;
  /** ElevenLabs: tried in order when primary `modelId` returns 403. */
  modelFallbackIds?: string[];
  /** ElevenLabs: used when `voiceId` is not in the account (e.g. shared-library voice). */
  fallbackVoiceId?: string;
}

export interface TTSAudioChunk {
  audio: Buffer;
  isFinal: boolean;
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

export interface VoiceInfo {
  voice_id: string;
  name: string;
  category?: string;
  language?: string;
  preview_url?: string;
  isDefault?: boolean;
}

export type VoiceProvider = 'elevenlabs' | 'chatterbox';

export interface VoiceClientConfig {
  provider: VoiceProvider;
  elevenlabsApiKey?: string;
  elevenlabsAgentId?: string;
  elevenlabsDefaultVoiceId?: string;
  chatterboxBaseUrl?: string;
  chatterboxDefaultVoicePath?: string;
  whisperModelSize?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
  whisperLanguageCode?: string;
}
