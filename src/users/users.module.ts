import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserController } from './user.controller';
import { UsersService } from './users.service';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { Company } from '../models/companies/company.entity';
import { Invitation } from '../models/users/invitation.entity';
import { PasswordResetToken } from '../models/users/password-reset-token.entity';
import { User } from '../models/users/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Invitation, Company, PasswordResetToken]),
    forwardRef(() => ApiKeysModule),
  ],
  controllers: [UserController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
