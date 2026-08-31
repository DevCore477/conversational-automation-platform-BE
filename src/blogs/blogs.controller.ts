import { Controller, Delete, Get, Param, Post, Query, UseGuards, UsePipes } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { BlogsService } from './blogs.service';
import { ListBlogsQueryDto } from './dto/list-blogs-query.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { FlexibleAuthGuard, RolesGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';

@ApiTags('Blogs')
@Controller('blogs')
export class BlogsController {
  constructor(private readonly blogsService: BlogsService) {}

  @Get()
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'List blogs (public — for the website)' })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'published'] })
  @ApiResponse({ status: 200, description: 'List of blogs' })
  findAll(@Query() query: ListBlogsQueryDto) {
    return this.blogsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single blog by id (public — for the website)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Blog' })
  @ApiResponse({ status: 404, description: 'Blog not found' })
  findOne(@Param('id') id: string) {
    return this.blogsService.findOne(id);
  }

  @Post('publish/:id')
  @UseGuards(FlexibleAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Publish a draft blog (admin only)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Blog published' })
  publish(@Param('id') id: string) {
    return this.blogsService.publish(id);
  }

  @Delete(':id')
  @UseGuards(FlexibleAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Delete a blog (admin only)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Blog deleted' })
  async remove(@Param('id') id: string) {
    await this.blogsService.remove(id);
    return { success: true };
  }
}
