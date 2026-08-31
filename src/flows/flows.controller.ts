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
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard, RolesGuard } from '../guards';
import { CreateFlowDto } from './dto/create-flow.dto';
import { UpdateFlowDto } from './dto/update-flow.dto';
import { getEffectiveFlow } from './flow-accessors';
import { FlowRuntimeService } from './flow-runtime.service';
import { FlowsService } from './flows.service';

type FlowsAuthRequest = ExpressRequest & {
  user?: { companyId?: string };
};

@Controller('flows')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard, RolesGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
export class FlowsController {
  constructor(
    private readonly flowsService: FlowsService,
    private readonly flowRuntime: FlowRuntimeService,
  ) {}

  /**
   *  List ALL flows (draft + published) for all companies (admin only)
   */
  @Get()
  @RequireApiKeyPermission('flows', 'read')
  @ApiOperation({ summary: 'Get all conversation flows' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Filter by company ID' })
  @ApiResponse({ status: 200, description: 'List of all conversation flows' })
  findAll(@Query('companyId') companyId: string | undefined, @Request() req: FlowsAuthRequest) {
    const resolved = companyId ?? req.user?.companyId ?? undefined;
    const filterId = resolved === '' ? undefined : resolved;
    if (filterId) {
      return this.flowsService.list(filterId);
    }
    return this.flowsService.listAll();
  }

  /**
   * List ALL flows (draft + published) for company
   */
  @Get('company/:companyId')
  @RequireApiKeyPermission('flows', 'read')
  list(@Param('companyId') companyId: string) {
    return this.flowsService.list(companyId);
  }

  /**
   * Create a DRAFT flow
   */
  @Post('company/:companyId')
  @RequireApiKeyPermission('flows', 'create')
  @UsePipes(ZodValidationPipe)
  @ApiBody({ type: CreateFlowDto })
  @ApiResponse({ status: 201, description: 'Flow created' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  createDraft(@Param('companyId') companyId: string, @Body() body: CreateFlowDto) {
    return this.flowsService.createDraft({
      companyId,
      name: body.name,
      scriptId: body.scriptId ?? null,
      flow: body.flow,
    });
  }

  /**
   * Update DRAFT flow JSON
   */
  @Patch(':flowId/company/:companyId')
  @RequireApiKeyPermission('flows', 'update')
  updateDraft(
    @Param('flowId') flowId: string,
    @Param('companyId') companyId: string,
    @Body() body: UpdateFlowDto,
  ) {
    return this.flowsService.updateDraft(flowId, companyId, body.flow, body.name);
  }

  /**
   * Validate a flow without publishing (VERY IMPORTANT)
   */
  @Post(':flowId/company/:companyId/validate')
  @RequireApiKeyPermission('flows', 'read')
  async validateFlow(@Param('flowId') flowId: string, @Param('companyId') companyId: string) {
    const result = await this.flowsService.validateFlow(flowId, companyId);

    return {
      flowId,
      companyId,
      ...result,
      summary: result.valid
        ? 'Flow is valid and ready to publish'
        : 'Flow has errors that must be fixed before publishing',
    };
  }

  /**
   * Publish flow (only after validation)
   */
  @Post(':flowId/company/:companyId/publish')
  @RequireApiKeyPermission('flows', 'update')
  async publish(@Param('flowId') flowId: string, @Param('companyId') companyId: string) {
    const flow = await this.flowsService.getDraft(flowId, companyId);
    if (!flow) {
      throw new Error('Flow not found');
    }

    // 🚨 Hard validation before publish (unwrap nested flow if stored as { start, flow: { nodes, start_node_id }, intents })
    this.flowRuntime.buildFirstMessage(getEffectiveFlow(flow.flow), {});

    return this.flowsService.publish(flowId, companyId);
  }

  @Post(':flowId/company/:companyId/status/:status')
  @RequireApiKeyPermission('flows', 'update')
  async updateStatus(
    @Param('flowId') flowId: string,
    @Param('companyId') companyId: string,
    @Param('status') status: 'draft' | 'published' | 'archived',
  ) {
    if (!['published', 'draft', 'archived'].includes(status)) {
      throw new Error('Invalid status');
    }

    return this.flowsService.updateFlowStatus(flowId, companyId, status);
  }

  /**
   * Get PUBLISHED flow (used by calls)
   */
  @Get('company/:companyId/published')
  @RequireApiKeyPermission('flows', 'read')
  getPublished(@Param('companyId') companyId: string) {
    return this.flowsService.getPublishedByCompany(companyId);
  }

  /**
   * Soft delete a flow (draft or published)
   */
  @Delete(':flowId/company/:companyId')
  @RequireApiKeyPermission('flows', 'delete')
  softDelete(@Param('flowId') flowId: string, @Param('companyId') companyId: string) {
    return this.flowsService.softDelete(flowId, companyId);
  }

  /**
   * Restore a soft-deleted flow
   */
  @Post(':flowId/company/:companyId/restore')
  @RequireApiKeyPermission('flows', 'update')
  restore(@Param('flowId') flowId: string, @Param('companyId') companyId: string) {
    return this.flowsService.restore(flowId, companyId);
  }

  /**
   * List soft-deleted flows (trash)
   */
  @Get('company/:companyId/trash')
  @RequireApiKeyPermission('flows', 'read')
  listDeleted(@Param('companyId') companyId: string) {
    return this.flowsService.listDeleted(companyId);
  }

  /**
   * Permanently delete a flow (hard delete)
   */
  @Delete(':flowId/company/:companyId/permanent')
  @RequireApiKeyPermission('flows', 'delete')
  hardDelete(@Param('flowId') flowId: string, @Param('companyId') companyId: string) {
    return this.flowsService.hardDelete(flowId, companyId);
  }
}
