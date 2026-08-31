import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService, ConfigType } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';

import { AgentsModule } from './agents/agents.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuthModule } from './auth/auth.module';
import { BlogsModule } from './blogs/blogs.module';
import { CallScriptModule } from './call-scripts/call-script.module';
import { CallsModule } from './calls/calls.module';
import { ElevenLabsModule } from './clients/elevenlabs/elevenlabs.module';
import { RoyalTransferModule } from './clients/royal-transfer/royal-transfer.module';
import { CompaniesModule } from './companies/companies.module';
import appConfig from './configs/app.config';
import authConfig from './configs/auth.config';
import callQueueConfig from './configs/call-queue.config';
import databaseConfig from './configs/database.config';
import elevenlabsConfig from './configs/elevenlabs.config';
import linkedinConfig from './configs/linkedin.config';
import mozoConfig from './configs/mozo.config';
import openaiConfig from './configs/openai.config';
import royalTransferConfig from './configs/royal-transfer.config';
import s3Config from './configs/s3.config';
import telnyxConfig from './configs/telnyx.config';
import twilioConfig from './configs/twilio.config';
import redisConfig from './configs/redis.config';
import whatsappConfig from './configs/whatsapp.config';
import vetClinicConfig from './configs/vet-clinic.config';
import voiceConfig from './configs/voice.config';
import webhookConfig from './configs/webhook.config';
import { ConnectUsModule } from './connect-us/connect-us.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { EmailModule } from './email/email.module';
import { FlowsModule } from './flows/flows.module';
import { GuardsModule } from './guards/guards.module';
import { LinkedInModule } from './linkedin/linkedin.module';
import { MozoModule } from './mozo/mozo.module';
import { NewsletterModule } from './newsletter/newsletter.module';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';
import { PlatformInboundVoiceModule } from './platform/platform-inbound-voice.module';
import { S3Module } from './s3/s3.module';
import { UsersModule } from './users/users.module';
import { VoiceModule } from './voice/voice.module';
import { WebhookModule } from './webhook/webhook.module';
import { WebsiteBlogsModule } from './website-blogs/website-blogs.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [
        appConfig,
        authConfig,
        callQueueConfig,
        webhookConfig,
        openaiConfig,
        twilioConfig,
        whatsappConfig,
        redisConfig,
        telnyxConfig,
        databaseConfig,
        elevenlabsConfig,
        royalTransferConfig,
        vetClinicConfig,
        voiceConfig,
        s3Config,
        linkedinConfig,
        mozoConfig,
      ],
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        const db = configService.getOrThrow<ConfigType<typeof databaseConfig>>('database');

        const {
          url,
          host,
          port,
          username,
          password,
          database,
          ssl,
          synchronize,
          entities,
          poolMax,
          poolIdleTimeoutMs,
          connectionTimeoutMs,
        } = db;

        const common: TypeOrmModuleOptions = {
          type: 'postgres' as const,
          synchronize,
          logging: false,
          ssl: ssl ? { rejectUnauthorized: false } : undefined,
          autoLoadEntities: false,
          entities,
          extra: {
            max: poolMax,
            idleTimeoutMillis: poolIdleTimeoutMs,
            connectionTimeoutMillis: connectionTimeoutMs,
          },
        };

        if (url) {
          return {
            ...common,
            url,
          };
        }

        return {
          ...common,
          host,
          port,
          username,
          password,
          database,
        };
      },
    }),
    GuardsModule,
    ConnectUsModule,
    VoiceModule,
    UsersModule,
    AuthModule,
    AgentsModule,
    CallsModule,
    CallScriptModule,
    WebhookModule,
    EmailModule,
    WhatsAppModule,
    ElevenLabsModule,
    RoyalTransferModule,
    DashboardModule,
    CompaniesModule,
    ApiKeysModule,
    FlowsModule,
    PlatformInboundVoiceModule,
    S3Module,
    NewsletterModule,
    LinkedInModule,
    BlogsModule,
    MozoModule,
    WebsiteBlogsModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
  ],
})
export class AppModule {}
