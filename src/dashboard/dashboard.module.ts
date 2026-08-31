import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { AgentsModule } from '../agents/agents.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { CallScriptModule } from '../call-scripts/call-script.module';
import { CallsModule } from '../calls/calls.module';
import { TwilioModule } from '../clients/twilio/twilio.module';
import { FlowsModule } from '../flows/flows.module';
import { UsersModule } from '../users/users.module';
import { TelnyxModule } from '../clients/telnyx/telnyx.module';

@Module({
  imports: [
    CallsModule,
    CallScriptModule,
    FlowsModule,
    AgentsModule,
    UsersModule,
    ApiKeysModule,
    TwilioModule,
    TelnyxModule,
    JwtModule.register({}),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
