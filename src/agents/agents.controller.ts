import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';

type AgentsAuthRequest = ExpressRequest & {
  user?: { companyId?: string };
};

@ApiTags('Agents')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post()
  @RequireApiKeyPermission('agents', 'create')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Create a new agent (flow, script, or LLM)' })
  @ApiResponse({ status: 201, description: 'Agent created' })
  create(@Body() dto: CreateAgentDto, @Request() req: AgentsAuthRequest) {
    const companyId = dto.companyId ?? req.user?.companyId ?? null;
    return this.agentsService.create({
      agentName: dto.agentName,
      companyId,
      channel: dto.channel,
      responseEngine: dto.responseEngine,
      language: dto.language,
      voiceId: dto.voiceId,
      maxCallDurationMs: dto.maxCallDurationMs,
      interruptionSensitivity: dto.interruptionSensitivity,
      dataStorageSetting: dto.dataStorageSetting,
      userDtmfOptions: dto.userDtmfOptions,
      isPublished: dto.isPublished,
      postCallAnalysisModel: dto.postCallAnalysisModel,
      conversationFlowMode: dto.conversationFlowMode,
      globalPrompt: dto.globalPrompt,
    });
  }

  @Get()
  @RequireApiKeyPermission('agents', 'read')
  @ApiOperation({ summary: 'List agents (optionally by company)' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Filter by company ID' })
  @ApiResponse({ status: 200, description: 'List of agents' })
  findAll(@Query('companyId') companyId: string | undefined, @Request() req: AgentsAuthRequest) {
    const resolved = companyId ?? req.user?.companyId ?? undefined;
    return this.agentsService.findAll(resolved === '' ? undefined : resolved);
  }

  @Get('company/:companyId')
  @RequireApiKeyPermission('agents', 'read')
  @ApiOperation({ summary: 'List agents for a company' })
  @ApiParam({ name: 'companyId' })
  findByCompany(@Param('companyId') companyId: string) {
    return this.agentsService.findByCompany(companyId);
  }

  @Get(':id')
  @RequireApiKeyPermission('agents', 'read')
  @ApiOperation({ summary: 'Get one agent by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Agent' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  findOne(@Param('id') id: string, @Request() req: AgentsAuthRequest) {
    const companyId = req.user?.companyId ?? null;
    return this.agentsService.findOne(id, companyId);
  }

  @Get(':id/for-call')
  @RequireApiKeyPermission('agents', 'read')
  @ApiOperation({
    summary: 'Get agent config for starting a call (validates published if required)',
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'requirePublished', required: false, type: Boolean })
  getForCall(@Param('id') id: string, @Query('requirePublished') requirePublished?: string) {
    return this.agentsService.getForCall(id, {
      requirePublished: requirePublished === 'true',
    });
  }

  @Patch(':id')
  @RequireApiKeyPermission('agents', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update an agent' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Agent updated' })
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto, @Request() req: AgentsAuthRequest) {
    const companyId = req.user?.companyId ?? null;
    return this.agentsService.update(id, dto, companyId);
  }

  @Delete(':id')
  @RequireApiKeyPermission('agents', 'delete')
  @ApiOperation({ summary: 'Delete an agent' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Agent deleted' })
  remove(@Param('id') id: string, @Request() req: AgentsAuthRequest) {
    const companyId = req.user?.companyId ?? null;
    return this.agentsService.remove(id, companyId);
  }
}
