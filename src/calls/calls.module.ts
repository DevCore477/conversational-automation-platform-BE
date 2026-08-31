import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CallRetryController } from './calls-retry.controller';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { AgentsModule } from '../agents/agents.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthModule } from '../auth/auth.module';
import { CallScriptModule } from '../call-scripts/call-script.module';
import { OpenAIModule } from '../clients/openai/openai.module';
import { TelnyxModule } from '../clients/telnyx/telnyx.module';
import { TwilioModule } from '../clients/twilio/twilio.module';
import { CompaniesModule } from '../companies/companies.module';
import authConfig from '../configs/auth.config';
import callsConfig from '../configs/calls.config';
import { FlowsModule } from '../flows/flows.module';
import { CallRecord } from '../models/calls/call-record.entity';
import { UsersModule } from '../users/users.module';
import { CallRecordService } from './services/call-record.service';
import { CallRetryService } from './services/call-retry.service';
import { InboundCallAdmissionService } from './services/inbound-call-admission.service';
import { InboundCallInsightService } from './services/inbound-call-insight.service';
import { CallStateService } from './services/call-state.service';
import { ConversationService } from './services/conversation.service';
import { ScriptOpeningMessageService } from './services/script-opening-message.service';
import { TrustedOriginOrAttachUserGuard } from '../guards/bypass-auth.guard';
import { MakeCallRateLimitGuard } from './gaurds/rate-limiting.guards';
import { VoiceModule } from '../voice/voice.module';
import { PlatformInboundVoiceModule } from '../platform/platform-inbound-voice.module';
import { OutboundCallQueueModule } from './queue/outbound-call-queue.module';

@Module({
  imports: [
    forwardRef(() => VoiceModule),
    forwardRef(() => OutboundCallQueueModule),
    ConfigModule.forRoot({
      load: [callsConfig],
    }),
    TypeOrmModule.forFeature([CallRecord]),
    TwilioModule,
    TelnyxModule,
    OpenAIModule,
    AuthModule,
    UsersModule,
    CallScriptModule,
    CompaniesModule,
    FlowsModule,
    AgentsModule,
    ApiKeysModule,
    PlatformInboundVoiceModule,
    JwtModule.registerAsync({
      imports: [ConfigModule.forFeature(authConfig)],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const cfg = configService.getOrThrow<{
          jwtSecret: string;
          jwtExpiresIn: string;
        }>('auth');
        return {
          secret: cfg.jwtSecret,
          signOptions: {
            expiresIn: cfg.jwtExpiresIn as
              | `${number}d`
              | `${number}h`
              | `${number}m`
              | `${number}s`,
          },
        };
      },
    }),
  ],
  controllers: [CallsController, CallRetryController],
  providers: [
    TrustedOriginOrAttachUserGuard,
    MakeCallRateLimitGuard,
    CallsService,
    CallStateService,
    ConversationService,
    CallRecordService,
    CallRetryService,
    ScriptOpeningMessageService,
    InboundCallInsightService,
    InboundCallAdmissionService,
  ],
  exports: [
    CallsService,
    CallStateService,
    ConversationService,
    CallRecordService,
    CallRetryService,
    InboundCallInsightService,
    InboundCallAdmissionService,
  ],
})
export class CallsModule {}
