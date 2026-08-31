import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { NewsletterService } from './newsletter.service';
import { SubscribeNewsletterDto } from './dto/subscribe-newsletter.dto';
import { BroadcastNewsletterDto } from './dto/broadcast-newsletter.dto';
import { FlexibleAuthGuard } from '../guards';
import type { ValidatedUser } from '../auth/services/token-validation.service';

type NewsletterRequest = ExpressRequest & { user?: ValidatedUser };

function requireAdmin(req: NewsletterRequest): ValidatedUser {
  const user = req.user;
  if (user == null) {
    throw new UnauthorizedException();
  }
  if (user.role !== 'admin') {
    throw new ForbiddenException('Only platform admins can access this resource');
  }
  return user;
}

@ApiTags('Newsletter')
@Controller('newsletter')
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  @Post('subscribe')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Subscribe an email address to the newsletter' })
  @ApiBody({ type: SubscribeNewsletterDto })
  @ApiResponse({ status: 201, description: 'Subscribed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid email address' })
  subscribe(@Body() dto: SubscribeNewsletterDto) {
    return this.newsletterService.subscribe(dto.email);
  }

  @Get('unsubscribe')
  @ApiOperation({ summary: 'Unsubscribe from the newsletter using the emailed token' })
  @ApiResponse({ status: 200, description: 'Unsubscribed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or missing token' })
  unsubscribe(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('Missing unsubscribe token');
    }
    return this.newsletterService.unsubscribe(token);
  }

  @Get()
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'List active newsletter subscribers (admin)' })
  @ApiResponse({ status: 200, description: 'List of active subscribers' })
  findAllActive(@Request() req: NewsletterRequest) {
    requireAdmin(req);
    return this.newsletterService.findAllActive();
  }

  @Post('broadcast')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Send a promotional/update email to all active subscribers (admin)',
  })
  @ApiBody({ type: BroadcastNewsletterDto })
  @ApiResponse({
    status: 202,
    description: 'Broadcast accepted and queued for sending',
  })
  broadcast(@Body() dto: BroadcastNewsletterDto, @Request() req: NewsletterRequest) {
    requireAdmin(req);
    return this.newsletterService.broadcast(dto.subject, dto.html, dto.text);
  }

  @Get('broadcasts')
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'List newsletter broadcast campaigns (admin)' })
  @ApiResponse({ status: 200, description: 'List of campaigns' })
  listCampaigns(@Request() req: NewsletterRequest) {
    requireAdmin(req);
    return this.newsletterService.listCampaigns();
  }

  @Get('broadcasts/:id')
  @UseGuards(FlexibleAuthGuard)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Get a broadcast campaign delivery status (admin)' })
  @ApiResponse({ status: 200, description: 'Campaign details' })
  @ApiResponse({ status: 404, description: 'Campaign not found' })
  getCampaign(@Param('id') id: string, @Request() req: NewsletterRequest) {
    requireAdmin(req);
    return this.newsletterService.findCampaign(id);
  }
}
