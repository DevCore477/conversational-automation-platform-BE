import { ITTSClient, TTSConfig, TTSAudioChunk, VoiceInfo } from './voice-client.interface';
import { ElevenLabsTTSClient, TTSStreamConfig } from '../elevenlabs/elevenlabs.client';

/**
 * Wraps the existing ElevenLabs TTS client so it satisfies {@link ITTSClient}
 * without changing ElevenLabs implementation.
 */
export class ElevenLabsTTSAdapter implements ITTSClient {
  constructor(private readonly client: ElevenLabsTTSClient) {}

  async streamTTS(
    config: TTSConfig,
    textIterator: AsyncIterable<string>,
    onAudioChunk: (chunk: TTSAudioChunk) => void | Promise<void>,
    onError?: (error: Error) => void,
  ): Promise<void> {
    const streamConfig: TTSStreamConfig = {
      voiceId: config.voiceId,
      fallbackVoiceId: config.fallbackVoiceId,
      modelId: config.modelId,
      modelFallbackIds: config.modelFallbackIds,
      outputFormat: config.outputFormat as TTSStreamConfig['outputFormat'],
      stability: config.stability,
      similarityBoost: config.similarityBoost,
      style: config.style,
      useSpeakerBoost: config.useSpeakerBoost,
      speed: config.speed,
    };
    return this.client.streamTTS(streamConfig, textIterator, onAudioChunk, onError);
  }

  generateSpeech(text: string, config: TTSConfig): Promise<Buffer> {
    const streamConfig: TTSStreamConfig = {
      voiceId: config.voiceId,
      fallbackVoiceId: config.fallbackVoiceId,
      modelId: config.modelId,
      modelFallbackIds: config.modelFallbackIds,
      outputFormat: config.outputFormat as TTSStreamConfig['outputFormat'],
      stability: config.stability,
      similarityBoost: config.similarityBoost,
      style: config.style,
      useSpeakerBoost: config.useSpeakerBoost,
      speed: config.speed,
    };
    return this.client.generateSpeech(text, streamConfig);
  }

  abort(): void {
    this.client.abort();
  }

  isActive(): boolean {
    return this.client.isActive();
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const res = await this.client.getVoices();
    return (res.voices ?? []).map(v => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      labels: v.labels,
      preview_url: v.preview_url,
    }));
  }

  healthCheck?(): Promise<{ status: string }> {
    return Promise.resolve({ status: 'ok' });
  }

  prewarm(config: TTSConfig): void {
    const streamConfig: TTSStreamConfig = {
      voiceId: config.voiceId,
      fallbackVoiceId: config.fallbackVoiceId,
      modelId: config.modelId,
      modelFallbackIds: config.modelFallbackIds,
      outputFormat: config.outputFormat as TTSStreamConfig['outputFormat'],
      stability: config.stability,
      similarityBoost: config.similarityBoost,
      style: config.style,
      useSpeakerBoost: config.useSpeakerBoost,
      speed: config.speed,
    };
    this.client.prewarm(streamConfig);
  }
}
