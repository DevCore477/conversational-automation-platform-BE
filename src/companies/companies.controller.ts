import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { canManageTenantCompanyWithApiKeyOrRole } from '../api-keys/api-key-permissions.util';
import type { ValidatedUser } from '../auth/services/token-validation.service';
import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { CompaniesService } from './companies.service';
import { AddUserToCompanyDto } from './dto/add-user-to-company.dto';
import { CompanyUsersResponseDto } from './dto/company-users-response.dto';
import { CreateCompanyDto } from './dto/create-company.dto';
import { DeleteCompanyDto } from './dto/delete-company.dto';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';
import { UpdateCompanyThemeDto } from './dto/update-company-theme.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UserResponseDto } from '../users/dto';
import { UpdateCompanyUserDto } from './dto/update-company-user.dto';

type CompaniesAuthRequest = ExpressRequest & { user?: ValidatedUser };

function requireUser(req: CompaniesAuthRequest): ValidatedUser {
  const user = req.user;
  if (user == null) {
    throw new UnauthorizedException();
  }
  return user;
}

function requireCompanyMembership(
  user: ValidatedUser,
  platformAdminMessage: string,
): asserts user is ValidatedUser & { companyId: string } {
  if (user.companyId == null || user.companyId === '') {
    throw new ForbiddenException(platformAdminMessage);
  }
}

@ApiTags('Companies')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Post()
  @RequireApiKeyPermission('companies', 'create')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Create a new company' })
  @ApiBody({ type: CreateCompanyDto })
  @ApiResponse({ status: 201, description: 'Company created successfully' })
  @ApiResponse({ status: 409, description: 'Company name already exists' })
  create(@Body() dto: CreateCompanyDto, @Request() req: CompaniesAuthRequest) {
    const user = requireUser(req);
    return this.companiesService.create({
      name: dto.name,
      email: dto.email,
      ownerId: user.id,
      description: dto.description,
      industry: dto.industry,
      website: dto.website,
    });
  }

  @Get('me')
  @RequireApiKeyPermission('companies', 'read')
  @ApiOperation({ summary: "Get current user's company" })
  @ApiResponse({ status: 200, description: 'Company details' })
  @ApiResponse({ status: 404, description: 'User not assigned to any company' })
  async getMyCompany(@Request() req: CompaniesAuthRequest) {
    const user = requireUser(req);
    if (!user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }
    return this.companiesService.findOneWithWhatsAppStatus(user.companyId, {
      inactiveAsForbidden: true,
    });
  }

  @Get('me/stats')
  @RequireApiKeyPermission('companies', 'read')
  @ApiOperation({ summary: 'Get current company statistics' })
  @ApiResponse({ status: 200, description: 'Company statistics' })
  async getMyCompanyStats(@Request() req: CompaniesAuthRequest) {
    const user = requireUser(req);
    if (!user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }
    return this.companiesService.getStats(user.companyId);
  }

  @Patch('me')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: "Update current user's company" })
  @ApiBody({ type: UpdateCompanyDto })
  @ApiResponse({ status: 200, description: 'Company updated successfully' })
  async updateMyCompany(@Body() dto: UpdateCompanyDto, @Request() req: CompaniesAuthRequest) {
    const user = requireUser(req);
    if (!user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can update company details');
    }

    return this.companiesService.update(user.companyId, dto);
  }

  @Patch('company/:companyId')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update company details (Platform Admin only)' })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiBody({ type: UpdateCompanyDto })
  @ApiResponse({ status: 200, description: 'Company updated successfully' })
  async updateCompanyById(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateCompanyDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can update other companies');
    }
    return this.companiesService.update(companyId, dto, { allowInactive: true });
  }

  @Patch('me/theme')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update company theme/branding' })
  @ApiBody({ type: UpdateCompanyThemeDto })
  @ApiResponse({ status: 200, description: 'Theme updated successfully' })
  async updateTheme(@Body() dto: UpdateCompanyThemeDto, @Request() req: CompaniesAuthRequest) {
    const user = requireUser(req);
    if (!user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can update theme');
    }

    return this.companiesService.updateTheme(user.companyId, dto);
  }

  @Patch('company/:companyId/theme')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update company theme/branding (Platform Admin only)' })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiBody({ type: UpdateCompanyThemeDto })
  @ApiResponse({ status: 200, description: 'Theme updated successfully' })
  async updateThemeById(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateCompanyThemeDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can update other companies');
    }
    return this.companiesService.updateTheme(companyId, dto, { allowInactive: true });
  }

  @Patch('me/settings')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update company settings' })
  @ApiBody({ type: UpdateCompanySettingsDto })
  @ApiResponse({ status: 200, description: 'Settings updated successfully' })
  async updateSettings(
    @Body() dto: UpdateCompanySettingsDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (!user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can update settings');
    }

    return this.companiesService.updateSettings(user.companyId, dto);
  }

  @Patch('company/:companyId/settings')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update company settings (Platform Admin only)' })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiBody({ type: UpdateCompanySettingsDto })
  @ApiResponse({ status: 200, description: 'Settings updated successfully' })
  async updateSettingsById(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateCompanySettingsDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can update other companies');
    }
    return this.companiesService.updateSettings(companyId, dto, { allowInactive: true });
  }

  @Get('me/users')
  @RequireApiKeyPermission('companies', 'read')
  @ApiOperation({
    summary: 'Get all users in current company (including pending invitations)',
    description:
      'Each user and pending invitation includes a `permissions` object derived from `companyRole` (manage company, users, API keys, calls, etc.).',
  })
  @ApiResponse({
    status: 200,
    description: 'List of company users and pending invitations',
    type: CompanyUsersResponseDto,
  })
  async getCompanyUsers(@Request() req: CompaniesAuthRequest): Promise<CompanyUsersResponseDto> {
    const user = requireUser(req);
    if (!user.companyId && user.role !== 'admin') {
      throw new ForbiddenException('User is not assigned to any company');
    }

    const companyId = user.companyId ?? null;
    if (!companyId) {
      throw new ForbiddenException(
        'Platform admins should use GET /companies/:companyId/users endpoint',
      );
    }

    return this.companiesService.getCompanyUsers(companyId, {});
  }

  @Get(':slug')
  @RequireApiKeyPermission('companies', 'read')
  @ApiOperation({ summary: 'Get company by slug (public)' })
  @ApiParam({ name: 'slug', description: 'Company slug' })
  @ApiResponse({ status: 200, description: 'Company details' })
  @ApiResponse({ status: 404, description: 'Company not found' })
  findBySlug(@Param('slug') slug: string) {
    return this.companiesService.findBySlug(slug);
  }

  @Get('/admins/:companyId/users')
  @RequireApiKeyPermission('companies', 'read')
  @ApiOperation({
    summary: 'Get all users in a specific company (Platform Admin only)',
    description:
      'Each user and pending invitation includes `permissions` derived from `companyRole`.',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiResponse({
    status: 200,
    description: 'List of company users and pending invitations',
    type: CompanyUsersResponseDto,
  })
  async getCompanyUsersById(
    @Param('companyId') companyId: string,
    @Request() req: CompaniesAuthRequest,
  ): Promise<CompanyUsersResponseDto> {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can access this endpoint');
    }

    return this.companiesService.getCompanyUsers(companyId, { allowInactive: true });
  }

  @Post('me/users')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Add user to current company' })
  @ApiBody({ type: AddUserToCompanyDto })
  @ApiResponse({ status: 201, description: 'User added to company' })
  @ApiResponse({
    status: 400,
    description: 'User already belongs to a company',
  })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async addUser(@Body() dto: AddUserToCompanyDto, @Request() req: CompaniesAuthRequest) {
    const user = requireUser(req);
    if (user.role === 'admin') {
      if (!user.companyId) {
        throw new ForbiddenException(
          'Platform admins should use POST /companies/:companyId/users endpoint',
        );
      }
    } else if (!user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (user.role !== 'admin' && !canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can add users');
    }

    requireCompanyMembership(
      user,
      'Platform admins should use POST /companies/admins/:companyId/users endpoint',
    );

    return this.companiesService.addUserByEmail(
      user.companyId,
      dto.email,
      dto.companyRole,
      dto.sendInviteEmail,
      user.id,
    );
  }

  @Post('/admins/:companyId/users')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Add user to specific company (Platform Admin only)',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiBody({ type: AddUserToCompanyDto })
  @ApiResponse({ status: 201, description: 'User added to company' })
  async addUserToCompany(
    @Param('companyId') companyId: string,
    @Body() dto: AddUserToCompanyDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can add users to other companies');
    }

    return this.companiesService.addUserByEmail(
      companyId,
      dto.email,
      dto.companyRole,
      dto.sendInviteEmail,
      user.id,
    );
  }

  @Patch('me/users/:userId')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Update company user (role, name, status)',
    description:
      'PATCH at least one of: companyRole, firstName, lastName, companyStatus. Replaces the former role-only PATCH .../role route.',
  })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiBody({ type: UpdateCompanyUserDto })
  @ApiResponse({ status: 200, description: 'User updated', type: UserResponseDto })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async updateCompanyUser(
    @Param('userId') userId: string,
    @Body() dto: UpdateCompanyUserDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    const isPlatformAdmin = user.role === 'admin';

    if (!isPlatformAdmin && !user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!isPlatformAdmin && !canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can update company users');
    }

    if (!isPlatformAdmin && user.companyRole === 'admin' && dto.companyRole === 'owner') {
      throw new ForbiddenException('Only owners can assign owner role');
    }

    requireCompanyMembership(
      user,
      'Platform admins must use PATCH /companies/admins/:companyId/users/:userId',
    );

    return this.companiesService.updateCompanyUser(user.companyId, userId, dto);
  }

  @Patch('/admins/:companyId/users/:userId')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Update company user in a specific company (Platform Admin only)',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiBody({ type: UpdateCompanyUserDto })
  @ApiResponse({ status: 200, description: 'User updated', type: UserResponseDto })
  async updateCompanyUserAsAdmin(
    @Param('companyId') companyId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateCompanyUserDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can update users in other companies');
    }

    return this.companiesService.updateCompanyUser(companyId, userId, dto, {
      allowInactive: true,
    });
  }

  @Delete('me/users/:userId')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({ summary: 'Remove user from company' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User removed from company' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async removeUser(@Param('userId') userId: string, @Request() req: CompaniesAuthRequest) {
    const user = requireUser(req);
    const isPlatformAdmin = user.role === 'admin';

    if (!isPlatformAdmin && !user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!isPlatformAdmin && !canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can remove users');
    }

    if (!isPlatformAdmin && userId === user.id) {
      throw new ForbiddenException('Cannot remove yourself. Have another owner/admin remove you.');
    }

    requireCompanyMembership(
      user,
      'Platform admins must use DELETE /companies/admins/:companyId/users/:userId',
    );

    await this.companiesService.removeUser(user.companyId, userId);

    return { message: 'User removed from company successfully' };
  }

  @Delete('/admins/:companyId/users/:userId')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({
    summary: 'Remove user from specific company (Platform Admin only)',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User removed from company' })
  async removeUserFromCompany(
    @Param('companyId') companyId: string,
    @Param('userId') userId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can remove users from other companies');
    }

    await this.companiesService.removeUser(companyId, userId, { allowInactive: true });

    return { message: 'User removed from company successfully' };
  }

  @Delete('me/invitations/:invitationId')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({ summary: 'Remove (revoke) a pending invitation' })
  @ApiParam({ name: 'invitationId', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation removed' })
  @ApiResponse({
    status: 403,
    description: 'Only company owners and admins can remove invitations',
  })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async removeInvitation(
    @Param('invitationId') invitationId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    const isPlatformAdmin = user.role === 'admin';

    if (!isPlatformAdmin && !user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!isPlatformAdmin && !canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can remove invitations');
    }

    requireCompanyMembership(
      user,
      'Platform admins must use DELETE /companies/admins/:companyId/invitations/:invitationId',
    );

    await this.companiesService.removeInvitation(user.companyId, invitationId);
    return { message: 'Invitation removed successfully' };
  }

  @Post('me/invitations/:invitationId/resend')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({ summary: 'Resend a pending invitation email' })
  @ApiParam({ name: 'invitationId', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation resent' })
  @ApiResponse({
    status: 403,
    description: 'Only company owners and admins can resend invitations',
  })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async resendInvitation(
    @Param('invitationId') invitationId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    const isPlatformAdmin = user.role === 'admin';

    if (!isPlatformAdmin && !user.companyId) {
      throw new ForbiddenException('User is not assigned to any company');
    }

    if (!isPlatformAdmin && !canManageTenantCompanyWithApiKeyOrRole(user)) {
      throw new ForbiddenException('Only company owners and admins can resend invitations');
    }

    requireCompanyMembership(
      user,
      'Platform admins must use POST /companies/admins/:companyId/invitations/:invitationId/resend',
    );

    await this.companiesService.resendInvitation(user.companyId, invitationId);
    return { message: 'Invitation resent successfully' };
  }

  @Delete('/admins/:companyId/invitations/:invitationId')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({ summary: 'Remove invitation in a company (Platform Admin only)' })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiParam({ name: 'invitationId', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation removed' })
  async removeInvitationInCompany(
    @Param('companyId') companyId: string,
    @Param('invitationId') invitationId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException(
        'Only platform admins can remove invitations in other companies',
      );
    }

    await this.companiesService.removeInvitation(companyId, invitationId, {
      allowInactive: true,
    });
    return { message: 'Invitation removed successfully' };
  }

  @Post('/admins/:companyId/invitations/:invitationId/resend')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({ summary: 'Resend invitation in a company (Platform Admin only)' })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiParam({ name: 'invitationId', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation resent' })
  async resendInvitationInCompany(
    @Param('companyId') companyId: string,
    @Param('invitationId') invitationId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException(
        'Only platform admins can resend invitations in other companies',
      );
    }

    await this.companiesService.resendInvitation(companyId, invitationId, {
      allowInactive: true,
    });
    return { message: 'Invitation resent successfully' };
  }

  @Get()
  @RequireApiKeyPermission('companies', 'read')
  @ApiOperation({
    summary: 'Get all companies (Platform Admin only)',
    description:
      'Returns active companies by default. Pass `includeInactive=true` to list deactivated tenants as well.',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    type: Boolean,
    description: 'When true, includes companies with `isActive: false`',
  })
  @ApiResponse({ status: 200, description: 'List of all companies' })
  async getAllCompanies(
    @Request() req: CompaniesAuthRequest,
    @Query('includeInactive') includeInactive?: string,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can view all companies');
    }

    const include =
      includeInactive === 'true' || includeInactive === '1' || includeInactive === 'yes';
    return this.companiesService.findAll({ includeInactive: include });
  }

  @Get('/admins/:companyId')
  @RequireApiKeyPermission('companies', 'read')
  @ApiOperation({
    summary: 'Get company by ID',
    description:
      'Platform admins may load any company including deactivated. Company members may only load their own company (`companyId` must match); deactivated tenants receive 403.',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiResponse({ status: 200, description: 'Company details' })
  async getCompanyById(
    @Param('companyId') companyId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role === 'admin') {
      return this.companiesService.findOne(companyId, { allowInactive: true });
    }
    if (user.companyId !== companyId) {
      throw new ForbiddenException('You can only access your own company details');
    }

    return this.companiesService.findOne(companyId, { inactiveAsForbidden: true });
  }

  @Delete('/admins/:companyId')
  @RequireApiKeyPermission('companies', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Delete a company permanently (Platform Admin only)',
    description:
      'Requires `confirmCompanyName` matching the company name. Removes invitations and conversation flows for the tenant, clears users’ `companyId` (and resets `companyRole` to `user`), nulls `companyId` on agents, clears `platformCompanyId` on platform inbound voice config when it pointed at this company, then deletes the company (DB CASCADE removes API keys, call scripts, and call records tied to this company).',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiBody({ type: DeleteCompanyDto })
  @ApiResponse({ status: 200, description: 'Company deleted' })
  @ApiResponse({ status: 400, description: 'Confirmation name mismatch' })
  @ApiResponse({ status: 404, description: 'Company not found' })
  async deleteCompanyAsAdmin(
    @Param('companyId') companyId: string,
    @Body() dto: DeleteCompanyDto,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can delete companies');
    }

    return this.companiesService.deleteCompanyAsPlatformAdmin(companyId, dto.confirmCompanyName);
  }

  @Post('/admins/:companyId/deactivate')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({
    summary: 'Soft-delete (deactivate) a company — Platform Admin only',
    description:
      'Sets `isActive` to `false`. API keys for the company stop validating; inbound routing by phone skips inactive companies; public lookup by slug returns 404. Data is retained; use permanent delete to remove the tenant. No-op if already inactive.',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiResponse({ status: 200, description: 'Company deactivated (or already inactive)' })
  @ApiResponse({ status: 404, description: 'Company not found' })
  async deactivateCompanyAsAdmin(
    @Param('companyId') companyId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can deactivate companies');
    }

    return this.companiesService.softDeleteCompanyAsPlatformAdmin(companyId);
  }

  @Post('/admins/:companyId/activate')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({
    summary: 'Reactivate a deactivated company — Platform Admin only',
    description:
      'Sets `isActive` to `true` so API keys, JWT access for tenant users, and inbound routing work again. No-op if already active.',
  })
  @ApiParam({ name: 'companyId', description: 'Company UUID' })
  @ApiResponse({ status: 200, description: 'Company reactivated (or already active)' })
  @ApiResponse({ status: 404, description: 'Company not found' })
  async activateCompanyAsAdmin(
    @Param('companyId') companyId: string,
    @Request() req: CompaniesAuthRequest,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can reactivate companies');
    }

    return this.companiesService.reactivateCompanyAsPlatformAdmin(companyId);
  }

  //   reset calls this month of company
  @Post('/admins/:companyId/reset-calls')
  @RequireApiKeyPermission('companies', 'update')
  @ApiOperation({ summary: 'Reset monthly call count' })
  @ApiResponse({ status: 200, description: 'Monthly call count reset' })
  async resetMonthlyCalls() {
    await this.companiesService.resetMonthlyCallCounts();
    return { message: 'Monthly call count reset successfully' };
  }
}
