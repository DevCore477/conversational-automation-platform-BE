import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentResponseVerificationService } from './agent-response-verification.service';
import { ConversationFlowToolExecutorService } from './conversation-flow-tool-executor.service';
import { FlowRuntimeService } from './flow-runtime.service';
import { FlowsController } from './flows.controller';
import { FlowsService } from './flows.service';
import { AgentsModule } from '../agents/agents.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthModule } from '../auth/auth.module';
import { OpenAIModule } from '../clients/openai/openai.module';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';
import { MozoApiModule } from '../mozo/mozo-api.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConversationFlow]),
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    forwardRef(() => ApiKeysModule),
    forwardRef(() => AgentsModule),
    // MozoApiModule (not MozoModule) deliberately — it has no other module deps, so this
    // can't participate in a cycle. See MozoApiModule's docblock for why that split exists.
    MozoApiModule,
    OpenAIModule,
  ],
  controllers: [FlowsController],
  providers: [
    FlowsService,
    FlowRuntimeService,
    AgentResponseVerificationService,
    ConversationFlowToolExecutorService,
  ],
  exports: [
    FlowsService,
    FlowRuntimeService,
    AgentResponseVerificationService,
    ConversationFlowToolExecutorService,
  ],
})
export class FlowsModule {}
