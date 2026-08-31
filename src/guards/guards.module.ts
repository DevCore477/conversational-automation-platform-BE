// guards/guards.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { ApiKeyPermissionGuard } from './api-key-permission.guard';
import { FlexibleAuthGuard } from './flexible-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OriginAwareAuthGuard } from './origin-aware-auth.guard';
import { RolesGuard } from './roles.guard';
import { UnifiedAuthGuard } from './unified-auth.guard';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ConfigModule, AuthModule, ApiKeysModule, UsersModule],
  providers: [
    UnifiedAuthGuard,
    JwtAuthGuard,
    ApiKeyAuthGuard,
    FlexibleAuthGuard,
    OriginAwareAuthGuard,
    RolesGuard,
    ApiKeyPermissionGuard,
  ],
  exports: [
    UnifiedAuthGuard,
    JwtAuthGuard,
    ApiKeyAuthGuard,
    FlexibleAuthGuard,
    OriginAwareAuthGuard,
    RolesGuard,
    ApiKeyPermissionGuard,
  ],
})
export class GuardsModule {}
