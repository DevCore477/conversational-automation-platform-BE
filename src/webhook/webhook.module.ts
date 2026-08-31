import { Module } from '@nestjs/common';

import { CallScriptModule } from '../call-scripts/call-script.module';
import { CallsModule } from '../calls/calls.module';
import { TelnyxModule } from '../clients/telnyx/telnyx.module';
import { KeyedAsyncLock } from '../common/utils/keyed-async-lock.service';
import { CompaniesModule } from '../companies/companies.module';
import { PlatformInboundVoiceModule } from '../platform/platform-inbound-voice.module';
import { InboundScriptResolverService } from './services/inbound-script-resolver.service';
import { TelnyxEventDedupService } from './services/telnyx-event-dedup.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    CallsModule,
    CallScriptModule,
    CompaniesModule,
    PlatformInboundVoiceModule,
    TelnyxModule,
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    InboundScriptResolverService,
    TelnyxEventDedupService,
    KeyedAsyncLock,
  ],
})
export class WebhookModule {}
