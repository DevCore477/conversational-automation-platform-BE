import { Module } from '@nestjs/common';

import { MozoApiService } from './services/mozo-api.service';
import { MozoTokenService } from './services/mozo-token.service';

/**
 * Split out of MozoModule so consumers that only need Mozo's own API client (e.g.
 * FlowsModule's mozo_create_order flow tool) don't have to pull in MozoModule's unrelated
 * DashboardModule dependency — that created a real circular chain (DashboardModule ->
 * FlowsModule -> MozoModule -> DashboardModule), which collided badly with the existing
 * VoiceModule <-> CallsModule cycle at boot. This module has no other module dependencies
 * (ConfigService is global), so nothing importing it can ever be part of a cycle through it.
 */
@Module({
  providers: [MozoTokenService, MozoApiService],
  exports: [MozoTokenService, MozoApiService],
})
export class MozoApiModule {}
