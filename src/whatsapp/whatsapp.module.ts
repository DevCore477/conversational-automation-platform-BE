import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentsModule } from '../agents/agents.module';
import { CallScriptModule } from '../call-scripts/call-script.module';
import { WhatsAppClientModule } from '../clients/whatsapp/whatsapp.module';
import { OpenAIModule } from '../clients/openai/openai.module';
import { FlowsModule } from '../flows/flows.module';
import { CompanyWhatsAppConfig } from '../models/whatsapp/company-whatsapp-config.entity';
import { WhatsAppCampaign } from '../models/whatsapp/whatsapp-campaign.entity';
import { WhatsAppContact } from '../models/whatsapp/whatsapp-contact.entity';
import { WhatsAppConversation } from '../models/whatsapp/whatsapp-conversation.entity';
import { WhatsAppInboundConfig } from '../models/whatsapp/whatsapp-inbound-config.entity';
import { WhatsAppJob } from '../models/whatsapp/whatsapp-job.entity';
import { WhatsAppMessage } from '../models/whatsapp/whatsapp-message.entity';
import { WhatsAppMessageMedia } from '../models/whatsapp/whatsapp-message-media.entity';
import { WhatsAppTemplate } from '../models/whatsapp/whatsapp-template.entity';
import { WhatsAppTemplateLibraryCache } from '../models/whatsapp/whatsapp-template-library-cache.entity';
import { S3Module } from '../s3/s3.module';
import { WhatsAppAdminController } from './controllers/whatsapp-admin.controller';
import { WhatsAppCampaignsController } from './controllers/whatsapp-campaigns.controller';
import { WhatsAppTemplatesController } from './controllers/whatsapp-templates.controller';
import { MetaTemplateApiService } from './services/meta-template-api.service';
import { MetaWhatsAppGraphService } from './services/meta-whatsapp-graph.service';
import { WhatsAppAudioTranscriptionService } from './services/media/whatsapp-audio-transcription.service';
import { WhatsAppDocumentExtractionService } from './services/media/whatsapp-document-extraction.service';
import { WhatsAppVideoProcessingService } from './services/media/whatsapp-video-processing.service';
import { WhatsAppVisionService } from './services/media/whatsapp-vision.service';
import { WhatsAppTemplateLibraryService } from './services/whatsapp-template-library.service';
import { WhatsAppTemplateSyncService } from './services/whatsapp-template-sync.service';
import { WhatsAppTemplateWebhookService } from './services/whatsapp-template-webhook.service';
import { WhatsAppMetaWebhookVerifyService } from './services/whatsapp-meta-webhook-verify.service';
import { WhatsAppMediaProcessor } from './queues/whatsapp-media.processor';
import { WhatsAppMediaQueueService } from './queues/whatsapp-media.queue';
import { WhatsAppOutboundProcessor } from './queues/whatsapp-outbound.processor';
import { WhatsAppOutboundQueueService } from './queues/whatsapp-outbound.queue';
import { WhatsAppRateLimiterService } from './queues/whatsapp-rate-limiter.service';
import { WhatsAppCampaignService } from './services/whatsapp-campaign.service';
import { WhatsAppChatService } from './services/whatsapp-chat.service';
import { WhatsAppConfigService } from './services/whatsapp-config.service';
import { WhatsAppContactService } from './services/whatsapp-contact.service';
import { WhatsAppContextBuilderService } from './services/whatsapp-context-builder.service';
import { WhatsAppConversationEngineService } from './services/whatsapp-conversation-engine.service';
import { WhatsAppConversationService } from './services/whatsapp-conversation.service';
import { WhatsAppInboundConfigService } from './services/whatsapp-inbound-config.service';
import { WhatsAppInboundHandlerService } from './services/whatsapp-inbound-handler.service';
import { WhatsAppMessageLogService } from './services/whatsapp-message-log.service';
import { WhatsAppOptOutService } from './services/whatsapp-optout.service';
import { WhatsAppOutboundService } from './services/whatsapp-outbound.service';
import { WhatsAppQueueProcessor } from './services/whatsapp-queue.processor';
import { WhatsAppQueueService } from './services/whatsapp-queue.service';
import { WhatsAppTemplateService } from './services/whatsapp-template.service';
import { WhatsAppTenantService } from './services/whatsapp-tenant.service';
import { WhatsAppBulkService } from './whatsapp-bulk.service';
import { WhatsAppConversationsController } from './whatsapp-conversations.controller';
import { WhatsAppMessageBuilderService } from './whatsapp-message-builder.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppMetaAdminController } from './whatsapp-meta-admin.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppConfigModule } from './whatsapp-config.module';

@Module({
  imports: [
    WhatsAppConfigModule,
    WhatsAppClientModule,
    TypeOrmModule.forFeature([
      WhatsAppConversation,
      WhatsAppMessage,
      WhatsAppMessageMedia,
      WhatsAppJob,
      WhatsAppCampaign,
      WhatsAppInboundConfig,
      CompanyWhatsAppConfig,
      WhatsAppContact,
      WhatsAppTemplate,
      WhatsAppTemplateLibraryCache,
    ]),
    OpenAIModule,
    FlowsModule,
    AgentsModule,
    CallScriptModule,
    S3Module,
  ],
  controllers: [
    WhatsAppController,
    WhatsAppWebhookController,
    WhatsAppConversationsController,
    WhatsAppMetaAdminController,
    WhatsAppCampaignsController,
    WhatsAppTemplatesController,
    WhatsAppAdminController,
  ],
  providers: [
    WhatsAppService,
    WhatsAppOutboundService,
    WhatsAppMessageBuilderService,
    WhatsAppBulkService,
    WhatsAppChatService,
    WhatsAppInboundConfigService,
    WhatsAppInboundHandlerService,
    WhatsAppConversationEngineService,
    WhatsAppQueueService,
    WhatsAppQueueProcessor,
    WhatsAppTenantService,
    WhatsAppContactService,
    WhatsAppOptOutService,
    WhatsAppConversationService,
    WhatsAppMessageLogService,
    WhatsAppTemplateService,
    WhatsAppTemplateLibraryService,
    WhatsAppTemplateSyncService,
    WhatsAppTemplateWebhookService,
    WhatsAppMetaWebhookVerifyService,
    MetaWhatsAppGraphService,
    MetaTemplateApiService,
    WhatsAppCampaignService,
    WhatsAppOutboundQueueService,
    WhatsAppOutboundProcessor,
    WhatsAppRateLimiterService,
    WhatsAppMediaQueueService,
    WhatsAppMediaProcessor,
    WhatsAppVisionService,
    WhatsAppAudioTranscriptionService,
    WhatsAppDocumentExtractionService,
    WhatsAppVideoProcessingService,
    WhatsAppContextBuilderService,
  ],
  exports: [
    WhatsAppService,
    WhatsAppMessageBuilderService,
    WhatsAppBulkService,
    WhatsAppChatService,
    WhatsAppQueueService,
    WhatsAppCampaignService,
    WhatsAppConfigModule,
    WhatsAppTenantService,
  ],
})
export class WhatsAppModule {}
