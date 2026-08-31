import { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ElevenLabsTTSClient } from './elevenlabs.client';

export const ElevenLabsClientProvider: FactoryProvider<ElevenLabsTTSClient> = {
  provide: ElevenLabsTTSClient,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const apiKey = config.getOrThrow<string>('elevenlabs.apiKey');
    const agentId = config.getOrThrow<string>('elevenlabs.agentId');
    const baseUrl = config.get<string>('elevenlabs.baseUrl', 'https://api.elevenlabs.io/v1');
    const defaultVoiceId = config.get<string>('elevenlabs.defaultVoiceId', 'EXAVITQu4vr4xnSDxMaL');

    console.log('✅ ElevenLabs config loaded:', {
      apiKey: `${apiKey.slice(0, 6)}***`,
      agentId,
      baseUrl,
      defaultVoiceId,
    });

    return new ElevenLabsTTSClient(apiKey);
  },
};
