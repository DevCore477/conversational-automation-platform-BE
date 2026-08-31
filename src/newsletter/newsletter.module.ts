import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NewsletterController } from './newsletter.controller';
import { NewsletterService } from './newsletter.service';
import { NewsletterOutboundQueueService } from './queues/newsletter-outbound.queue';
import { NewsletterOutboundProcessor } from './queues/newsletter-outbound.processor';
import { NewsletterSubscriber } from '../models/newsletter/newsletter-subscriber.entity';
import { NewsletterCampaign } from '../models/newsletter/newsletter-campaign.entity';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [TypeOrmModule.forFeature([NewsletterSubscriber, NewsletterCampaign]), EmailModule],
  controllers: [NewsletterController],
  providers: [NewsletterService, NewsletterOutboundQueueService, NewsletterOutboundProcessor],
  exports: [NewsletterService],
})
export class NewsletterModule {}
