import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Agent } from '../models/agents/agent.entity';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { GuardsModule } from '../guards/guards.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([Agent]), UsersModule, ApiKeysModule, GuardsModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
