import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import type { ValidatedUser } from '../auth/services/token-validation.service';
import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';

type ApiKeysAuthRequest = ExpressRequest & { user?: ValidatedUser };

function requireUser(req: ApiKeysAuthRequest): ValidatedUser {
  const user = req.user;
  if (user == null) {
    throw new UnauthorizedException();
  }
  return user;
}

@ApiTags('API Keys')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  @RequireApiKeyPermission('apiKeys', 'create')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Create a new API key',
    description:
      'Generate a new API key for your company. The plain key is only shown once - save it securely!',
  })
  @ApiBody({ type: CreateApiKeyDto })
  @ApiResponse({
    status: 201,
    description: 'API key created successfully. Plain key is only shown once!',
  })
  async create(@Body() dto: CreateApiKeyDto, @Request() req: ApiKeysAuthRequest) {
    const user = requireUser(req);
    if (user.companyId == null) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!['owner', 'admin'].includes(user.companyRole ?? '')) {
      throw new ForbiddenException('Only company owners and admins can create API keys');
    }

    return this.apiKeysService.create({
      companyId: user.companyId,
      name: dto.name,
      description: dto.description,
      permissions: dto.permissions,
      restrictions: dto.restrictions,
      expiresAt: dto.expiresAt != null ? new Date(dto.expiresAt) : undefined,
      createdBy: user.id,
    });
  }

  @Get()
  @RequireApiKeyPermission('apiKeys', 'read')
  @ApiOperation({ summary: 'Get all API keys for your company' })
  @ApiResponse({ status: 200, description: 'List of API keys' })
  getAll(@Request() req: ApiKeysAuthRequest) {
    const user = requireUser(req);
    if (user.companyId == null) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    return this.apiKeysService.findByCompany(user.companyId);
  }

  @Get('stats')
  @RequireApiKeyPermission('apiKeys', 'read')
  @ApiOperation({ summary: 'Get API key statistics' })
  @ApiResponse({ status: 200, description: 'API key statistics' })
  getStats(@Request() req: ApiKeysAuthRequest) {
    const user = requireUser(req);
    if (user.companyId == null) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    return this.apiKeysService.getStats(user.companyId);
  }

  @Get(':id')
  @RequireApiKeyPermission('apiKeys', 'read')
  @ApiOperation({ summary: 'Get API key details by ID' })
  @ApiParam({ name: 'id', description: 'API Key UUID' })
  @ApiResponse({ status: 200, description: 'API key details' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  findOne(@Param('id') id: string, @Request() req: ApiKeysAuthRequest) {
    const user = requireUser(req);
    if (user.companyId == null) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    return this.apiKeysService.findOne(id, user.companyId);
  }

  @Patch(':id')
  @RequireApiKeyPermission('apiKeys', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Update API key',
    description:
      'Update metadata, permissions, expiry, or activation. Set `isActive: false` to revoke (deactivate) a key; `isActive: true` to enable again.',
  })
  @ApiParam({ name: 'id', description: 'API Key UUID' })
  @ApiResponse({ status: 200, description: 'API key updated successfully' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyDto,
    @Request() req: ApiKeysAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.companyId == null) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!['owner', 'admin'].includes(user.companyRole ?? '')) {
      throw new ForbiddenException('Only company owners and admins can update API keys');
    }

    return this.apiKeysService.update(id, user.companyId, dto);
  }

  @Delete(':id')
  @RequireApiKeyPermission('apiKeys', 'delete')
  @ApiOperation({ summary: 'Delete an API key permanently' })
  @ApiParam({ name: 'id', description: 'API Key UUID' })
  @ApiResponse({ status: 200, description: 'API key deleted successfully' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async delete(@Param('id') id: string, @Request() req: ApiKeysAuthRequest) {
    const user = requireUser(req);
    if (user.companyId == null) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!['owner', 'admin'].includes(user.companyRole ?? '')) {
      throw new ForbiddenException('Only company owners and admins can delete API keys');
    }

    await this.apiKeysService.delete(id, user.companyId);
    return { message: 'API key deleted successfully' };
  }
}
