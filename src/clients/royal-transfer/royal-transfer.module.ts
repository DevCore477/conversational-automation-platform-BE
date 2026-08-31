import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RoyalTransferClient } from './royal-transfer.client';
import { RoyalTransferController } from './royal-transfer.controller';
import { RoyalTransferClientProvider } from './royal-transfer.provider';
import { RoyalTransferService } from './royal-transfer.service';
import { ApiKeysModule } from '../../api-keys/api-keys.module';
import { AuthModule } from '../../auth/auth.module';
import { CallsModule } from '../../calls/calls.module';
import { OutboundCallQueueModule } from '../../calls/queue/outbound-call-queue.module';
import royalTransferConfig from '../../configs/royal-transfer.config';
import { UsersModule } from '../../users/users.module';

@Module({
  imports: [
    ConfigModule.forFeature(royalTransferConfig),
    forwardRef(() => CallsModule),
    forwardRef(() => OutboundCallQueueModule),
    ApiKeysModule,
    AuthModule,
    UsersModule,
  ],
  controllers: [RoyalTransferController],
  providers: [RoyalTransferClientProvider, RoyalTransferService],
  exports: [RoyalTransferClient, RoyalTransferService],
})
export class RoyalTransferModule {}
