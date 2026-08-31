import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { ApiKey } from '../models/companies/api-key.entity';
import { Company } from '../models/companies/company.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, Company]), JwtModule.register({})],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
