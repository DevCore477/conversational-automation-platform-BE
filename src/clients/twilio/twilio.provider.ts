import { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TwilioClient } from './twilio.client';

export const TwilioClientProvider: FactoryProvider<TwilioClient> = {
  provide: TwilioClient,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const accountSid = config.getOrThrow<string>('twilio.accountSid');
    const authToken = config.getOrThrow<string>('twilio.authToken');
    return new TwilioClient(accountSid, authToken);
  },
};
