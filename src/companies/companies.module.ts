import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { EmailModule } from '../email/email.module';
import { CallScript } from '../models/call-scripts/call-script.entity';
import { ApiKey } from '../models/companies/api-key.entity';
import { Company } from '../models/companies/company.entity';
import { Invitation } from '../models/users/invitation.entity';
import { User } from '../models/users/user.entity';
import { UsersModule } from '../users/users.module';
import { WhatsAppConfigModule } from '../whatsapp/whatsapp-config.module';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';
import { Agent } from '../models/agents/agent.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Company,
      ApiKey,
      User,
      CallScript,
      Invitation,
      Agent,
      ConversationFlow,
    ]),
    JwtModule.register({}),
    forwardRef(() => UsersModule),
    forwardRef(() => ApiKeysModule),
    forwardRef(() => EmailModule),
    WhatsAppConfigModule,
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService, TypeOrmModule],
})
export class CompaniesModule {}
