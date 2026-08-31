import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Request,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { ConnectUsService } from './connect-us.service';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { CreateConnectUsDto } from './dto/create-connect-us.dto';
import { FlexibleAuthGuard } from '../guards';
import type { ValidatedUser } from '../auth/services/token-validation.service';

type ConnectUsUser = ExpressRequest & { user?: ValidatedUser };

function requireUser(req: ConnectUsUser): ValidatedUser {
  const user = req.user;
  if (user == null) {
    throw new UnauthorizedException();
  }
  return user;
}

@ApiTags('Connect Us')
@Controller('connect-us')
export class ConnectUsController {
  constructor(private readonly connectUsService: ConnectUsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Submit a Connect Us form' })
  @ApiBody({ type: CreateConnectUsDto })
  @ApiResponse({
    status: 201,
    description: 'Form submission created successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid form data',
  })
  create(@Body() dto: CreateConnectUsDto) {
    return this.connectUsService.create(dto);
  }

  @Get()
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Get all Connect Us submissions (admin)' })
  @ApiResponse({
    status: 200,
    description: 'List of all submissions',
  })
  findAll(@Request() req: ConnectUsUser) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can access all submissions');
    }
    return this.connectUsService.findAll();
  }

  @Get(':id')
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Get a Connect Us submission by ID (admin)' })
  @ApiResponse({
    status: 200,
    description: 'Submission details',
  })
  @ApiResponse({
    status: 404,
    description: 'Submission not found',
  })
  async findOne(@Param('id') id: string, @Request() req: ConnectUsUser) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can access submissions');
    }
    const submission = await this.connectUsService.findOne(id);
    if (!submission) {
      throw new NotFoundException('Submission not found');
    }
    return submission;
  }

  @Patch(':id')
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update a Connect Us submission (admin)' })
  @ApiBody({
    schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
  })
  @ApiResponse({
    status: 200,
    description: 'Submission updated successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Submission not found',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: { status: string },
    @Request() req: ConnectUsUser,
  ) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can update submissions');
    }
    const updated = await this.connectUsService.update(id, dto);
    if (!updated) {
      throw new NotFoundException('Submission not found');
    }
    return updated;
  }

  @Delete(':id')
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Delete a Connect Us submission (admin)' })
  @ApiResponse({
    status: 204,
    description: 'Submission deleted successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Submission not found',
  })
  async remove(@Param('id') id: string, @Request() req: ConnectUsUser) {
    const user = requireUser(req);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can delete submissions');
    }
    const deleted = await this.connectUsService.remove(id);
    if (!deleted) {
      throw new NotFoundException('Submission not found');
    }
    return {
      status: 204,
      message: 'Submission deleted successfully',
    };
  }
}
