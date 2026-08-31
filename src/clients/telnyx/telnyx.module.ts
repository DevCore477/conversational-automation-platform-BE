import { Module } from '@nestjs/common';

import { TelnyxClient } from './telnyx.client';
import { TelnyxClientProvider } from './telnyx.provider';
import { TelnyxPhoneNumberService } from './telnyx-phone-number.service';

@Module({
  providers: [TelnyxClientProvider, TelnyxPhoneNumberService],
  exports: [TelnyxClient, TelnyxPhoneNumberService],
})
export class TelnyxModule {}
