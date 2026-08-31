import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentsModule } from '../agents/agents.module';
import { CallScriptModule } from '../call-scripts/call-script.module';
import { CompaniesModule } from '../companies/companies.module';
import { FlowsModule } from '../flows/flows.module';
import { PlatformInboundVoiceConfig } from '../models/platform-inbound-voice/platform-inbound-voice-config.entity';
import { PlatformInboundVoiceController } from './platform-inbound-voice.controller';
import { PlatformInboundVoiceService } from './platform-inbound-voice.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([PlatformInboundVoiceConfig]),
    AgentsModule,
    CallScriptModule,
    FlowsModule,
    CompaniesModule,
  ],
  controllers: [PlatformInboundVoiceController],
  providers: [PlatformInboundVoiceService],
  exports: [PlatformInboundVoiceService],
})
export class PlatformInboundVoiceModule {}
