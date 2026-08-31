import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiBody,
} from '@nestjs/swagger';

import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { FlexibleAuthGuard, RolesGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { GetMembersQueryDto } from './dto/get-members-query.dto';
import { PaginatedUsersResponseDto } from './dto/paginated-users-response.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@UseGuards(FlexibleAuthGuard, RolesGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
@Controller('users')
export class UserController {
  constructor(private readonly usersService: UsersService) {}

  @Get('members')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Get paginated list of users with filtering (Admin only)',
    description:
      'Retrieve a paginated list of users. Supports filtering by role, search by name/email, and custom sorting. `meta.counts` summarizes users matching the current `search` (platform admins vs members, with/without company). Counts ignore the `role` filter so totals stay visible while viewing a single role page.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (default: 10, max: 100)',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search by email, first name, last name, or full name',
    example: 'john',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: UserRole,
    description: 'Filter by user role (if not provided, returns all users)',
    example: UserRole.MEMBER,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'email', 'firstName', 'lastName'],
    description: 'Field to sort by (default: createdAt)',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order (default: DESC)',
    example: 'DESC',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of users',
    type: PaginatedUsersResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Admin access required',
  })
  @ApiResponse({ status: 400, description: 'Invalid query parameters' })
  async getMembersPaginated(
    @Query() query: GetMembersQueryDto,
  ): Promise<PaginatedUsersResponseDto> {
    const { page, limit, search, role, companyId, sortBy, sortOrder } = query;

    const { users, total, counts } = await this.usersService.getMembersPaginated(
      page,
      limit,
      search,
      role,
      companyId,
      sortBy,
      sortOrder,
    );
    const totalPages = Math.ceil(total / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      data: users.map(user => ({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        companyId: user.companyId,
        companyRole: user.companyRole,
        company: user.company ? { name: user.company.name } : null,
      })),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasNextPage,
        hasPreviousPage,
        counts,
      },
    };
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update a user (Admin only)' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiBody({ type: UpdateUserDto })
  @ApiResponse({ status: 200, description: 'User updated', type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    const user = await this.usersService.updateUser(id, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      role: dto.role as UserRole,
    });
    return this.usersService.sanitize(user);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a user from the platform (Admin only)' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User deleted' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteUser(@Param('id') id: string) {
    await this.usersService.deleteUser(id);
    return { message: 'User deleted successfully' };
  }
}
