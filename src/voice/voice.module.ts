import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ElevenLabsVoiceBridgeService } from './elevanlabs.voice-bridge-service.service';
import { VoiceMediaGateway } from './voice-media.gateway';
import { VoiceTerminalReplService } from './voice-terminal-repl.service';
import { VoiceClientFactory } from '../clients/voice-client/voice-client.factory';
import voiceConfig from '../configs/voice.config';
import { AgentsModule } from '../agents/agents.module';
import { CallsModule } from '../calls/calls.module';
import { RoyalTransferModule } from '../clients/royal-transfer/royal-transfer.module';
import { TwilioModule } from '../clients/twilio/twilio.module';
import { FlowsModule } from '../flows/flows.module';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';
import { OpenAIClient } from '../clients/openai/openai.client';
import { TelnyxModule } from '../clients/telnyx/telnyx.module';
import { PlatformInboundVoiceModule } from '../platform/platform-inbound-voice.module';

@Module({
  imports: [
    ConfigModule.forFeature(voiceConfig),
    TypeOrmModule.forFeature([ConversationFlow]),
    forwardRef(() => CallsModule),
    forwardRef(() => FlowsModule),
    forwardRef(() => RoyalTransferModule),
    forwardRef(() => AgentsModule),
    TwilioModule,
    TelnyxModule,
    forwardRef(() => PlatformInboundVoiceModule),
  ],
  providers: [
    VoiceClientFactory,
    VoiceMediaGateway,
    ElevenLabsVoiceBridgeService,
    VoiceTerminalReplService,
    {
      provide: OpenAIClient,
      useFactory: (configService: ConfigService) => {
        const apiKey = configService.get<string>('openai.apiKey');
        return new OpenAIClient(apiKey ?? '');
      },
      inject: [ConfigService],
    },
  ],
  exports: [VoiceClientFactory, VoiceTerminalReplService, ElevenLabsVoiceBridgeService],
})
export class VoiceModule {}
