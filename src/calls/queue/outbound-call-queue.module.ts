import { forwardRef, Module } from '@nestjs/common';

import { OutboundCallQueueService } from './outbound-call-queue.service';
import { OutboundCallWorker } from './outbound-call.worker';
import { CallsModule } from '../calls.module';

/**
 * Separate module (rather than folding these providers into CallsModule directly) so the queue
 * can be imported by other feature modules (e.g. RoyalTransferModule) without pulling in a
 * circular dependency on CallsModule's controllers/guards.
 */
@Module({
  imports: [forwardRef(() => CallsModule)],
  providers: [OutboundCallQueueService, OutboundCallWorker],
  exports: [OutboundCallQueueService, OutboundCallWorker],
})
export class OutboundCallQueueModule {}
