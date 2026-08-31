import { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TelnyxClient } from './telnyx.client';

export const TelnyxClientProvider: FactoryProvider<TelnyxClient> = {
  provide: TelnyxClient,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const apiKey = config.get<string>('telnyx.apiKey') ?? '';
    const connectionId = config.get<string>('telnyx.connectionId') ?? '';
    return new TelnyxClient(apiKey, connectionId);
  },
};
