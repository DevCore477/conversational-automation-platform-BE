import { Module } from '@nestjs/common';

import { OpenAIClient } from './openai.client';
import { OpenAIClientProvider } from './openai.provider';

@Module({
  providers: [OpenAIClientProvider],
  exports: [OpenAIClient],
})
export class OpenAIModule {}
