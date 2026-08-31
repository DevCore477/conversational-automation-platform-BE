import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AdminListWebsiteBlogsQueryDto } from './dto/admin-list-website-blogs-query.dto';
import { CreateWebsiteBlogDto } from './dto/create-website-blog.dto';
import { UpdateWebsiteBlogDto } from './dto/update-website-blog.dto';
import {
  PaginatedWebsiteBlogsResponseDto,
  WebsiteBlogAdminDetailDto,
} from './dto/website-blog-response.dto';
import { toAdminDetail, toListItem } from './website-blog.mapper';
import { WebsiteBlogsService } from './website-blogs.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../common/enums';
import { FlexibleAuthGuard, RolesGuard } from '../guards';

/**
 * Super Admin management endpoints for the public website's blog content. Gated with
 * `UserRole.ADMIN` — the same global (non-tenant) admin role used by the LinkedIn
 * integration's own admin-only routes, since this codebase has no separate
 * "Super Admin" role.
 */
@ApiTags('Website Blogs (Admin)')
@Controller('admin/website-blogs')
@UseGuards(FlexibleAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth('BearerAuth')
export class AdminWebsiteBlogsController {
  constructor(private readonly websiteBlogsService: WebsiteBlogsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a blog (Super Admin)' })
  @ApiResponse({ status: 201, type: WebsiteBlogAdminDetailDto })
  @ApiResponse({ status: 409, description: 'Slug already in use' })
  async create(
    @Body() dto: CreateWebsiteBlogDto,
    @CurrentUser('id') userId: string,
  ): Promise<WebsiteBlogAdminDetailDto> {
    const blog = await this.websiteBlogsService.create(dto, userId);
    return toAdminDetail(blog);
  }

  @Get()
  @ApiOperation({ summary: 'List all blogs, including drafts (Super Admin)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'published', 'unpublished'] })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiResponse({ status: 200, type: PaginatedWebsiteBlogsResponseDto })
  async findAll(
    @Query() query: AdminListWebsiteBlogsQueryDto,
  ): Promise<PaginatedWebsiteBlogsResponseDto> {
    const { page, limit, search, status, category } = query;
    const { data, total } = await this.websiteBlogsService.findAllAdmin({
      page,
      limit,
      search,
      status,
      category,
    });

    const totalPages = Math.ceil(total / limit) || 0;
    return {
      data: data.map(toListItem),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get full blog details by id (Super Admin)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WebsiteBlogAdminDetailDto })
  @ApiResponse({ status: 404, description: 'Blog not found' })
  async findOne(@Param('id') id: string): Promise<WebsiteBlogAdminDetailDto> {
    const blog = await this.websiteBlogsService.findOneAdmin(id);
    return toAdminDetail(blog);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a blog (Super Admin)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WebsiteBlogAdminDetailDto })
  @ApiResponse({ status: 404, description: 'Blog not found' })
  @ApiResponse({ status: 409, description: 'Slug already in use' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateWebsiteBlogDto,
  ): Promise<WebsiteBlogAdminDetailDto> {
    const blog = await this.websiteBlogsService.update(id, dto);
    return toAdminDetail(blog);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a blog (Super Admin, soft delete)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Blog deleted' })
  @ApiResponse({ status: 404, description: 'Blog not found' })
  async remove(@Param('id') id: string): Promise<{ success: true }> {
    await this.websiteBlogsService.remove(id);
    return { success: true };
  }

  @Patch(':id/publish')
  @ApiOperation({ summary: 'Publish a blog (Super Admin)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WebsiteBlogAdminDetailDto })
  @ApiResponse({ status: 404, description: 'Blog not found' })
  async publish(@Param('id') id: string): Promise<WebsiteBlogAdminDetailDto> {
    const blog = await this.websiteBlogsService.publish(id);
    return toAdminDetail(blog);
  }

  @Patch(':id/unpublish')
  @ApiOperation({ summary: 'Unpublish a blog (Super Admin)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: WebsiteBlogAdminDetailDto })
  @ApiResponse({ status: 404, description: 'Blog not found' })
  async unpublish(@Param('id') id: string): Promise<WebsiteBlogAdminDetailDto> {
    const blog = await this.websiteBlogsService.unpublish(id);
    return toAdminDetail(blog);
  }
}
