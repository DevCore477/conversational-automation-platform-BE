import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
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
  ApiBody,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { CallScriptService } from './call-script.service';
import { CreateCallScriptDto } from './dto/create-call-script.dto';
import { SetDefaultScriptDto } from './dto/set-default-script.dto';
import { UpdateCallScriptDto } from './dto/update-call-script.dto';
import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request.types';

type CallScriptAuthRequest = ExpressRequest & {
  user?: { companyId?: string };
};

@ApiTags('Call Scripts')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
@Controller('call-scripts')
export class CallScriptController {
  constructor(private readonly callScriptService: CallScriptService) {}

  @Post()
  @RequireApiKeyPermission('scripts', 'create')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Create a new call script' })
  @ApiBody({ type: CreateCallScriptDto })
  @ApiResponse({
    status: 201,
    description: 'Call script created successfully',
  })
  @ApiResponse({ status: 409, description: 'Script name already exists' })
  create(@Body() dto: CreateCallScriptDto, @Request() req: CallScriptAuthRequest) {
    const companyId = dto.companyId ?? req.user?.companyId;
    return this.callScriptService.create({
      name: dto.name,
      script: dto.script,
      description: dto.description,
      firstMessage: dto.firstMessage,
      model: dto.model,
      voiceId: dto.voiceId,
      callType: dto.callType,
      isActive: dto.isActive,
      isDefault: dto.isDefault,
      companyId,
    });
  }

  @Get()
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'List call scripts (all companies, or scoped by company)' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Filter by company ID' })
  @ApiResponse({ status: 200, description: 'List of call scripts' })
  findAll(
    @Query('companyId') companyId: string | undefined,
    @Request() req: CallScriptAuthRequest,
  ) {
    const resolved = companyId ?? req.user?.companyId ?? undefined;
    const filterId = resolved === '' ? undefined : resolved;
    if (filterId) {
      return this.callScriptService.findAllByCompany(filterId);
    }
    return this.callScriptService.findAll();
  }

  @Get('company/:companyId')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'List call scripts for a company' })
  @ApiParam({ name: 'companyId' })
  @ApiResponse({ status: 200, description: 'List of call scripts for the company' })
  findByCompany(@Param('companyId') companyId: string) {
    return this.callScriptService.findAllByCompany(companyId);
  }

  @Get('active')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get all active call scripts' })
  @ApiResponse({ status: 200, description: 'List of active call scripts' })
  findAllActive() {
    return this.callScriptService.findAllActive();
  }

  @Get('default')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get the default call script' })
  @ApiResponse({ status: 200, description: 'Default call script' })
  @ApiResponse({ status: 404, description: 'No default script found' })
  getDefault() {
    return this.callScriptService.getDefaultOrThrow();
  }

  @Get('stats')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get call script statistics' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Scope statistics to a company' })
  @ApiResponse({ status: 200, description: 'Script statistics' })
  getStats(
    @Query('companyId') companyId: string | undefined,
    @Request() req: CallScriptAuthRequest,
  ) {
    const resolved = companyId ?? req.user?.companyId ?? undefined;
    const filterId = resolved === '' ? undefined : resolved;
    return this.callScriptService.getStats(filterId);
  }

  @Get('inbound')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get all scripts for inbound calls' })
  @ApiResponse({ status: 200, description: 'List of inbound call scripts' })
  findInboundScripts() {
    return this.callScriptService.findByCallType('inbound');
  }

  @Get('outbound')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get all scripts for outbound calls' })
  @ApiResponse({ status: 200, description: 'List of outbound call scripts' })
  findOutboundScripts() {
    return this.callScriptService.findByCallType('outbound');
  }

  @Get('default/inbound')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get the default inbound call script' })
  @ApiResponse({ status: 200, description: 'Default inbound script' })
  @ApiResponse({ status: 404, description: 'No default inbound script found' })
  async getDefaultInbound() {
    const script = await this.callScriptService.findDefaultByType('inbound');
    if (!script) {
      throw new NotFoundException('No default inbound script found');
    }
    return script;
  }

  @Get('default/outbound')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get the default outbound call script' })
  @ApiResponse({ status: 200, description: 'Default outbound script' })
  @ApiResponse({ status: 404, description: 'No default outbound script found' })
  async getDefaultOutbound() {
    const script = await this.callScriptService.findDefaultByType('outbound');
    if (!script) {
      throw new NotFoundException('No default outbound script found');
    }
    return script;
  }

  @Get(':id/stats')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get usage statistics for a specific script' })
  @ApiParam({ name: 'id', description: 'Script UUID' })
  @ApiResponse({ status: 200, description: 'Script usage statistics' })
  @ApiResponse({ status: 404, description: 'Script not found' })
  getScriptStats(@Param('id') id: string) {
    return this.callScriptService.getScriptStats(id);
  }

  @Get(':id')
  @RequireApiKeyPermission('scripts', 'read')
  @ApiOperation({ summary: 'Get a call script by ID' })
  @ApiParam({ name: 'id', description: 'Script UUID' })
  @ApiResponse({ status: 200, description: 'Call script details' })
  @ApiResponse({ status: 404, description: 'Script not found' })
  findOne(@Param('id') id: string) {
    return this.callScriptService.findOne(id);
  }

  @Patch(':id')
  @RequireApiKeyPermission('scripts', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update a call script' })
  @ApiParam({ name: 'id', description: 'Script UUID' })
  @ApiBody({ type: UpdateCallScriptDto })
  @ApiResponse({ status: 200, description: 'Script updated successfully' })
  @ApiResponse({ status: 404, description: 'Script not found' })
  @ApiResponse({ status: 409, description: 'Script name already exists' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCallScriptDto,
    @CurrentUser() user: RequestUser,
  ) {
    const companyId = user.companyId;
    return this.callScriptService.update(id, dto, companyId);
  }

  @Post('set-default')
  @RequireApiKeyPermission('scripts', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Set a script as the default' })
  @ApiBody({ type: SetDefaultScriptDto })
  @ApiResponse({ status: 200, description: 'Default script set successfully' })
  @ApiResponse({ status: 404, description: 'Script not found' })
  @ApiResponse({
    status: 400,
    description: 'Cannot set inactive script as default',
  })
  setDefault(@Body() dto: SetDefaultScriptDto) {
    return this.callScriptService.setDefault(dto.scriptId);
  }

  @Patch(':id/toggle-active')
  @RequireApiKeyPermission('scripts', 'update')
  @ApiOperation({ summary: 'Toggle active status of a script' })
  @ApiParam({ name: 'id', description: 'Script UUID' })
  @ApiResponse({ status: 200, description: 'Status toggled successfully' })
  @ApiResponse({ status: 404, description: 'Script not found' })
  @ApiResponse({
    status: 400,
    description: 'Cannot deactivate default script',
  })
  toggleActive(@Param('id') id: string) {
    return this.callScriptService.toggleActive(id);
  }

  @Delete(':id')
  @RequireApiKeyPermission('scripts', 'delete')
  @ApiOperation({ summary: 'Delete a call script' })
  @ApiParam({ name: 'id', description: 'Script UUID' })
  @ApiResponse({ status: 200, description: 'Script deleted successfully' })
  @ApiResponse({ status: 404, description: 'Script not found' })
  @ApiResponse({ status: 400, description: 'Cannot delete default script' })
  async delete(@Param('id') id: string) {
    await this.callScriptService.delete(id);
    return { message: 'Script deleted successfully' };
  }
}
