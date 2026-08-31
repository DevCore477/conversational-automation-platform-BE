import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LinkedInApiClient } from './linkedin-api.client';
import { LinkedInController } from './linkedin.controller';
import { LinkedInService } from './linkedin.service';
import { LinkedInSyncService } from './linkedin-sync.service';
import { BlogsModule } from '../blogs/blogs.module';
import { GuardsModule } from '../guards/guards.module';
import { LinkedInOrganization } from '../models/linkedin/linkedin-organization.entity';
import { LinkedInPost } from '../models/linkedin/linkedin-post.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([LinkedInOrganization, LinkedInPost]),
    // Separate signing key/audience from the user-session JWT — OAuth state tokens are
    // short-lived (10m) and only ever verified by this module.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow('auth.jwtSecret'),
        signOptions: { expiresIn: '10m' },
      }),
      inject: [ConfigService],
    }),
    GuardsModule,
    BlogsModule,
  ],
  controllers: [LinkedInController],
  providers: [LinkedInService, LinkedInSyncService, LinkedInApiClient],
  exports: [LinkedInService],
})
export class LinkedInModule {}
