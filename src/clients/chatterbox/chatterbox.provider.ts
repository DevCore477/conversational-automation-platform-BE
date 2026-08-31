import { FactoryProvider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChatterboxTTSClient } from './chatterbox.client';
import { WhisperSTTClient } from '../whisper/whisper.client';

export const ChatterboxTTSClientProvider: FactoryProvider<ChatterboxTTSClient> = {
  provide: 'CHATTERBOX_TTS_CLIENT',
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const baseUrl = config.get<string>('voice.chatterbox.baseUrl', 'http://localhost:4123');
    const defaultVoicePath = config.get<string>(
      'voice.chatterbox.defaultVoicePath',
      './voice-sample.mp3',
    );
    const apiType = config.get<'openai' | 'gradio'>('voice.chatterbox.apiType', 'openai');
    const gradioFnIndex = config.get<number>('voice.chatterbox.gradioFnIndex', 0);
    const gradioIncludeVoiceInput = config.get<boolean>(
      'voice.chatterbox.gradioIncludeVoiceInput',
      false,
    );
    const gradioApiName = config.get<string>('voice.chatterbox.gradioApiName', 'wrap_generate');
    const gradioLangName = config.get<string>('voice.chatterbox.gradioLangName', '');

    const logger = new Logger('ChatterboxProvider');
    logger.log('✅ Chatterbox TTS config loaded:', {
      baseUrl,
      defaultVoicePath,
      apiType,
      gradioApiName,
    });

    return new ChatterboxTTSClient(baseUrl, defaultVoicePath, {
      apiType,
      gradioFnIndex,
      gradioIncludeVoiceInput,
      gradioApiName,
      gradioLangName,
    });
  },
};

export const WhisperSTTClientProvider: FactoryProvider<WhisperSTTClient> = {
  provide: 'WHISPER_STT_CLIENT',
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const modelSize = config.get<string>('whisper.modelSize', 'base');
    const languageCode = config.get<string>('whisper.languageCode', 'en');

    const logger = new Logger('WhisperProvider');
    logger.log('✅ Whisper STT config loaded:', {
      modelSize,
      languageCode,
    });

    return new WhisperSTTClient({
      modelSize: modelSize as any,
      languageCode,
    });
  },
};
