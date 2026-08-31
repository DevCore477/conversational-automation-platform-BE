import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConnectUsController } from './connect-us.controller';
import { ConnectUsSubmission } from '../models/connect-us/connect-us.entity';
import { ConnectUsService } from './connect-us.service';

@Module({
  imports: [TypeOrmModule.forFeature([ConnectUsSubmission])],
  controllers: [ConnectUsController],
  providers: [ConnectUsService],
  exports: [ConnectUsService],
})
export class ConnectUsModule {}
