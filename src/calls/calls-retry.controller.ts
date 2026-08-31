import { Controller, Get, Post, Param, Delete, UseGuards, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';
import { CallRetryService } from './services/call-retry.service';

@ApiTags('Call Retries')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
@Controller('calls/retries')
export class CallRetryController {
  constructor(private readonly callRetryService: CallRetryService) {}

  @Post(':callSid/schedule')
  @RequireApiKeyPermission('calls', 'update')
  @ApiOperation({ summary: 'Manually schedule a call for retry' })
  @ApiParam({ name: 'callSid', description: 'Call SID to retry' })
  @ApiQuery({
    name: 'hours',
    required: false,
    description: 'Hours to wait before retry (default: 2)',
  })
  @ApiResponse({ status: 200, description: 'Call scheduled for retry' })
  @ApiResponse({ status: 404, description: 'Call not found' })
  scheduleRetry(@Param('callSid') callSid: string, @Query('hours') hours?: string) {
    const retryAfterHours = hours ? parseInt(hours, 10) : 2;
    return this.callRetryService.scheduleCallForRetry(callSid, retryAfterHours);
  }

  @Delete(':callSid/cancel')
  @RequireApiKeyPermission('calls', 'update')
  @ApiOperation({ summary: 'Cancel pending retry for a call' })
  @ApiParam({ name: 'callSid', description: 'Call SID' })
  @ApiResponse({ status: 200, description: 'Retry cancelled' })
  @ApiResponse({ status: 404, description: 'Call not found' })
  cancelRetry(@Param('callSid') callSid: string) {
    return this.callRetryService.cancelRetry(callSid);
  }

  @Get('stats')
  @RequireApiKeyPermission('calls', 'read')
  @ApiOperation({ summary: 'Get retry statistics' })
  @ApiResponse({ status: 200, description: 'Retry statistics' })
  getRetryStats() {
    return this.callRetryService.getRetryStats();
  }

  @Post('trigger')
  @RequireApiKeyPermission('calls', 'update')
  @ApiOperation({
    summary: 'Manually trigger retry job (for testing)',
    description: 'Triggers the retry job immediately instead of waiting for cron',
  })
  @ApiResponse({ status: 200, description: 'Retry job triggered' })
  async triggerRetryJob() {
    await this.callRetryService.handleCallRetries();
    return { message: 'Retry job triggered successfully' };
  }
}
