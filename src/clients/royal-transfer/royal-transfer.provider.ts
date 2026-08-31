import { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RoyalTransferClient } from './royal-transfer.client';

export const RoyalTransferClientProvider: FactoryProvider<RoyalTransferClient> = {
  provide: RoyalTransferClient,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const baseUrl =
      config.get<string>('royalTransfer.baseUrl') ??
      config.get<string>('ROYAL_TRANSFER_BASE_URL') ??
      '';
    const apiSecret =
      config.get<string>('royalTransfer.apiSecret') ??
      config.get<string>('ROYAL_TRANSFER_API_SECRET') ??
      config.get<string>('MICROSERVICE_SECRET') ??
      '';
    const useBearerAuth = config.get<string>('ROYAL_TRANSFER_USE_BEARER_AUTH') === 'true';

    if (!baseUrl || !apiSecret) {
      throw new Error(
        'Royal Transfer client requires ROYAL_TRANSFER_BASE_URL and ROYAL_TRANSFER_API_SECRET (or MICROSERVICE_SECRET)',
      );
    }

    return new RoyalTransferClient(baseUrl, apiSecret, { useBearerAuth });
  },
};
