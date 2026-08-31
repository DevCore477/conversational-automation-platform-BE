import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WhatsAppMetaToken } from '../../models/whatsapp/whatsapp-meta-token.entity';
import { MetaTokenService } from './meta-token.service';
import { WHATSAPP_CLIENT, WhatsAppClientProvider } from './whatsapp.provider';

@Module({
  imports: [TypeOrmModule.forFeature([WhatsAppMetaToken])],
  providers: [MetaTokenService, WhatsAppClientProvider],
  exports: [WHATSAPP_CLIENT, MetaTokenService],
})
export class WhatsAppClientModule {}
