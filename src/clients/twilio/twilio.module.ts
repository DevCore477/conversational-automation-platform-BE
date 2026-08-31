import { Module } from '@nestjs/common';

import { TwilioClient } from './twilio.client';
import { TwilioClientProvider } from './twilio.provider';

@Module({
  providers: [TwilioClientProvider],
  exports: [TwilioClient],
})
export class TwilioModule {}
