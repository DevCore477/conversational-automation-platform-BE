import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiQuery,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { DashboardService } from './dashboard.service';
import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';

type DashboardRequest = ExpressRequest & {
  user?: { companyId?: string };
};

@ApiTags('Dashboard stats')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
@Controller('dashboard-stats')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get dashboard overview with key metrics',
    description:
      'Returns comprehensive dashboard statistics including call stats, script stats, and recent activity',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Sliding window ending at now',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard overview retrieved successfully',
  })
  getOverview(
    @Request() req: DashboardRequest,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
  ) {
    return this.dashboardService.getOverview(req.user?.companyId, period);
  }

  @Get('scripts/performance')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get detailed performance metrics for all scripts',
    description:
      'Returns `{ scripts, usage }`: per-script KPIs for the resolved time window plus a time-series `usage` object ' +
      '(same bucket grain as GET .../calls/volume/by-resource: `period`, `window`, `data[]` with totals per bucket by status, `totals`, `peak`). ' +
      'Without time params, defaults to last 24 hours. Filter by `from`/`to`, `period`, or `scriptId`.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive start (ISO 8601)' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive end (ISO 8601)' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Sliding window ending at now; ignored if from or to is set',
  })
  @ApiQuery({ name: 'scriptId', required: false, description: 'Limit to this script UUID' })
  @ApiResponse({
    status: 200,
    description: 'Script performance metrics retrieved successfully',
  })
  getScriptPerformance(
    @Request() req: DashboardRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
    @Query('scriptId') scriptId?: string,
  ) {
    return this.dashboardService.getScriptPerformance(req.user?.companyId, {
      from,
      to,
      period,
      scriptId,
    });
  }

  @Get('flows/performance')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get performance metrics for all conversation flows',
    description:
      'Returns `{ flows, usage }`: per-flow KPIs plus `usage` time-series (calls attributed via `metadata.flowId`). ' +
      'Defaults to last 24h without time params. Same query filters as scripts.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive start (ISO 8601)' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive end (ISO 8601)' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Sliding window ending at now; ignored if from or to is set',
  })
  @ApiQuery({ name: 'flowId', required: false, description: 'Limit to this flow UUID' })
  @ApiResponse({ status: 200, description: 'Flow performance metrics retrieved successfully' })
  getFlowPerformance(
    @Request() req: DashboardRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
    @Query('flowId') flowId?: string,
  ) {
    return this.dashboardService.getFlowPerformance(req.user?.companyId, {
      from,
      to,
      period,
      flowId,
    });
  }

  @Get('agents/performance')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get performance metrics for all agents',
    description:
      'Returns `{ agents, usage }`: per-agent KPIs plus `usage` time-series (calls with `metadata.agentId`). ' +
      'Defaults to last 24h without time params. Same query filters as scripts.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive start (ISO 8601)' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive end (ISO 8601)' })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Sliding window ending at now; ignored if from or to is set',
  })
  @ApiQuery({ name: 'agentId', required: false, description: 'Limit to this agent UUID' })
  @ApiResponse({ status: 200, description: 'Agent performance metrics retrieved successfully' })
  getAgentPerformance(
    @Request() req: DashboardRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
    @Query('agentId') agentId?: string,
  ) {
    return this.dashboardService.getAgentPerformance(req.user?.companyId, {
      from,
      to,
      period,
      agentId,
    });
  }

  @Get('activity/recent')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get recent call activity',
    description: 'Returns a list of recent calls with details',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of calls to return (default: 50)',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Sliding window ending at now',
  })
  @ApiResponse({
    status: 200,
    description: 'Recent call activity retrieved successfully',
  })
  getRecentActivity(
    @Request() req: DashboardRequest,
    @Query('limit') limit?: string,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    return this.dashboardService.getRecentActivity(limitNum, req.user?.companyId, period);
  }

  @Get('calls/volume')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get call volume over time',
    description: 'Returns time-series data showing call volume for the specified period',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week'],
    description: 'Time period for volume analysis (default: day)',
  })
  @ApiResponse({
    status: 200,
    description: 'Call volume data retrieved successfully',
  })
  getCallVolume(
    @Request() req: DashboardRequest,
    @Query('period') period?: 'hour' | 'day' | 'week',
  ) {
    return this.dashboardService.getCallVolume(period ?? 'day', req.user?.companyId);
  }

  @Get('calls/volume/by-resource')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get call volume over time by resource type',
    description:
      'Time buckets with counts split by primary attribution: agent, conversation flow, script, or other (same period options as calls/volume).',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Time period for volume analysis (default: day)',
  })
  @ApiResponse({
    status: 200,
    description: 'Resource-scoped call volume retrieved successfully',
  })
  getResourceCallVolume(
    @Request() req: DashboardRequest,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
  ) {
    return this.dashboardService.getResourceCallVolume(period ?? 'day', req.user?.companyId);
  }

  @Get('scripts/top')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get top performing scripts',
    description: 'Returns the most frequently used scripts sorted by total calls',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of scripts to return (default: 10)',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Sliding window ending at now',
  })
  @ApiResponse({
    status: 200,
    description: 'Top scripts retrieved successfully',
  })
  getTopScripts(
    @Request() req: DashboardRequest,
    @Query('limit') limit?: string,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.dashboardService.getTopScripts(limitNum, req.user?.companyId, period);
  }

  @Get('system/health')
  @RequireApiKeyPermission('analytics', 'read')
  @ApiOperation({
    summary: 'Get system health status',
    description: 'Returns system health metrics and identifies potential issues',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['hour', 'day', 'week', 'month'],
    description: 'Sliding window ending at now',
  })
  @ApiResponse({
    status: 200,
    description:
      'System health metrics. The payload includes `providerCredits`: Twilio prepaid `balance`/`currency` (when available) and ElevenLabs `characterCount`, `characterLimit`, `charactersRemaining`, `tier`, and optional `nextCharacterCountResetUnix` from the subscription API.',
  })
  getSystemHealth(
    @Request() req: DashboardRequest,
    @Query('period') period?: 'hour' | 'day' | 'week' | 'month',
  ) {
    return this.dashboardService.getSystemHealth(req.user?.companyId, period);
  }
}
