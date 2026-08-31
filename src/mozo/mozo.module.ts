import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MozoIframeSessionGuard } from './guards/mozo-iframe-session.guard';
import { MozoApiModule } from './mozo-api.module';
import { MozoController } from './mozo.controller';
import { MozoPublicKeyService } from './services/mozo-public-key.service';
import { MozoVenueLinkService } from './services/mozo-venue-link.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { MozoVenueLink } from '../models/mozo/mozo-venue-link.entity';

// AuthService / TokenValidationService come from the @Global() AuthModule — no explicit import needed.
// JwtModule.register({}) here is only for MozoIframeSessionGuard's RS256-against-Mozo's-key
// verification — every call passes its own publicKey/algorithms, so no module-level secret needed.
// MozoTokenService/MozoApiService live in MozoApiModule (see its docblock) specifically so
// FlowsModule can use MozoApiService without pulling in DashboardModule transitively.
@Module({
  imports: [
    TypeOrmModule.forFeature([MozoVenueLink]),
    DashboardModule,
    JwtModule.register({}),
    MozoApiModule,
  ],
  controllers: [MozoController],
  providers: [MozoVenueLinkService, MozoPublicKeyService, MozoIframeSessionGuard],
})
export class MozoModule {}
