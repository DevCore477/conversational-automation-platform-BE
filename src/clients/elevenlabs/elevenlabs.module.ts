import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ElevenLabsTTSClient } from './elevenlabs.client';
import { ElevenLabsClientProvider } from './elevenlabs.provider';
import elevenlabsConfig from '../../configs/elevenlabs.config';
import { ElevenLabsController } from '../../elevanlabs/elevanlabs.controller';

@Module({
  imports: [ConfigModule.forFeature(elevenlabsConfig)],
  controllers: [ElevenLabsController],
  providers: [ElevenLabsClientProvider],
  exports: [ElevenLabsTTSClient],
})
export class ElevenLabsModule {}
