import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CallScriptController } from './call-script.controller';
import { CallScriptService } from './call-script.service';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { GuardsModule } from '../guards/guards.module';
import { CallScript } from '../models/call-scripts/call-script.entity';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CallScript]),
    JwtModule.register({}),
    UsersModule,
    ApiKeysModule,
    GuardsModule,
  ],
  controllers: [CallScriptController],
  providers: [CallScriptService],
  exports: [CallScriptService],
})
export class CallScriptModule {}
