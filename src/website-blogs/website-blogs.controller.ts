import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { PublicListWebsiteBlogsQueryDto } from './dto/public-list-website-blogs-query.dto';
import {
  PaginatedWebsiteBlogsResponseDto,
  WebsiteBlogPublicDetailDto,
} from './dto/website-blog-response.dto';
import { toListItem, toPublicDetail } from './website-blog.mapper';
import { WebsiteBlogsService } from './website-blogs.service';

/**
 * Public, unauthenticated endpoints for the marketing website. Only ever returns
 * published, non-deleted posts — drafts and internal fields never reach here.
 */
@ApiTags('Website Blogs (Public)')
@Controller('website-blogs')
export class WebsiteBlogsController {
  constructor(private readonly websiteBlogsService: WebsiteBlogsService) {}

  @Get()
  @ApiOperation({ summary: 'List published blogs, newest first' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'tag', required: false, type: String })
  @ApiResponse({ status: 200, type: PaginatedWebsiteBlogsResponseDto })
  async findAll(
    @Query() query: PublicListWebsiteBlogsQueryDto,
  ): Promise<PaginatedWebsiteBlogsResponseDto> {
    const { page, limit, search, category, tag } = query;
    const { data, total } = await this.websiteBlogsService.findPublished({
      page,
      limit,
      search,
      category,
      tag,
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

  @Get(':slug')
  @ApiOperation({ summary: 'Get a single published blog by slug' })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 200, type: WebsiteBlogPublicDetailDto })
  @ApiResponse({ status: 404, description: 'Blog not found or not published' })
  async findBySlug(@Param('slug') slug: string): Promise<WebsiteBlogPublicDetailDto> {
    const blog = await this.websiteBlogsService.findPublishedBySlug(slug);
    return toPublicDetail(blog);
  }
}
