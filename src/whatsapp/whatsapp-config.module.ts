import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompanyWhatsAppConfig } from '../models/whatsapp/company-whatsapp-config.entity';
import { WhatsAppConfigService } from './services/whatsapp-config.service';

/**
 * Minimal WhatsApp module for company/auth status flags — avoids pulling Agents/Flows/CallScript
 * (which create a circular dependency via GuardsModule → AuthModule → CompaniesModule).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CompanyWhatsAppConfig])],
  providers: [WhatsAppConfigService],
  exports: [WhatsAppConfigService],
})
export class WhatsAppConfigModule {}
