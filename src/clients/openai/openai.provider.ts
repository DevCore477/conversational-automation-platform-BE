import { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OpenAIClient } from './openai.client';

export const OpenAIClientProvider: FactoryProvider<OpenAIClient> = {
  provide: OpenAIClient,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const apiKey = config.getOrThrow<string>('openai.apiKey');
    return new OpenAIClient(apiKey);
  },
};
