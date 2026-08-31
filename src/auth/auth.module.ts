// auth/auth.module.ts
import { forwardRef, Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmbeddedSessionRateLimitGuard } from './guards/embedded-session-rate-limit.guard';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { CompaniesModule } from '../companies/companies.module';
import { EmailModule } from '../email/email.module';
import { Company } from '../models/companies/company.entity';
import { Invitation } from '../models/users/invitation.entity';
import { MozoBridgeSecretGuard } from '../mozo/guards/mozo-bridge-secret.guard';
import { PasswordResetToken } from '../models/users/password-reset-token.entity';
import { RefreshToken } from '../models/users/refresh-token.entity';
import { UsersModule } from '../users/users.module';
import { WhatsAppConfigModule } from '../whatsapp/whatsapp-config.module';
import { TokenValidationService } from './services/token-validation.service';

@Global()
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow('auth.jwtSecret'),
        signOptions: {
          expiresIn: configService.get('auth.jwtAccessExpiresIn', '7d'),
        },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([Company, Invitation, PasswordResetToken, RefreshToken]),
    UsersModule,
    EmailModule,
    CompaniesModule,
    WhatsAppConfigModule,
    forwardRef(() => ApiKeysModule),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenValidationService,
    EmbeddedSessionRateLimitGuard,
    MozoBridgeSecretGuard,
  ],
  exports: [AuthService, TokenValidationService],
})
export class AuthModule {}
