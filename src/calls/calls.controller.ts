import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Param,
  Post,
  Query,
  Request,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import { JobType } from 'bullmq';

import { CallsService } from './calls.service';
import { MakeCallDto } from './dto/make-call.dto';
import { InboundCallAdmissionService } from './services/inbound-call-admission.service';
import { OutboundCallQueueService } from './queue/outbound-call-queue.service';
import { OutboundCallWorker } from './queue/outbound-call.worker';
import type { ValidatedUser } from '../auth/services/token-validation.service';
import { buildIdempotencyJobId } from './utils/idempotency-key.util';
import { resolveTrustedCallerAttribution } from './utils/trusted-caller-attribution.util';
import { checkApiKeyPermission } from '../api-keys/api-key-permissions.util';
import { TrustedOriginOrAttachUserGuard } from '../guards/bypass-auth.guard';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';
import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { MakeCallRateLimitGuard } from './gaurds/rate-limiting.guards';

type CallsAuthRequest = ExpressRequest & {
  user?: ValidatedUser & { userId?: string };
};

@ApiTags('Calls')
@ApiSecurity('ApiKey')
@Controller('calls')
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly configService: ConfigService,
    private readonly outboundCallQueue: OutboundCallQueueService,
    private readonly outboundCallWorker: OutboundCallWorker,
    private readonly inboundCallAdmission: InboundCallAdmissionService,
  ) {}

  @Get('queue/health')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Redis/BullMQ health for the outbound call queue and inbound admission control',
  })
  @Get('queue/health')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Check outbound queue, worker and inbound Redis health',
  })
  async getQueueHealth() {
    const [outboundQueue, inboundRedis] = await Promise.all([
      this.outboundCallQueue.getStatus(),
      Promise.resolve(this.inboundCallAdmission.getRedisStatus()),
    ]);
    const worker = this.outboundCallWorker.getStatus();
    const healthy = outboundQueue.redis.healthy && worker.running && inboundRedis.healthy;
    const acceptingCalls = healthy && !outboundQueue.paused;
    return {
      healthy,
      acceptingCalls,
      outboundQueue: {
        queueName: outboundQueue.queueName,
        redis: outboundQueue.redis,
        paused: outboundQueue.paused,
        worker,
        counts: outboundQueue.counts,
      },
      inboundAdmission: {
        redis: inboundRedis,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('queue/metrics')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Get outbound call queue operational metrics',
  })
  async getQueueMetrics() {
    return this.outboundCallQueue.getMetrics();
  }

  @Post('queue/pause')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'update')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Pause outbound call queue',
    description:
      'Pauses processing of new outbound calls. Calls already active are allowed to finish.',
  })
  @ApiResponse({
    status: 200,
    description: 'Queue successfully paused',
  })
  async pauseQueue() {
    try {
      const alreadyPaused = await this.outboundCallQueue.isPaused();

      if (alreadyPaused) {
        return {
          success: true,
          paused: true,
          message: 'Outbound call queue is already paused.',
        };
      }

      await this.outboundCallQueue.pause();

      return {
        success: true,
        paused: true,
        message: 'Outbound call queue paused. Active calls will continue until they finish.',
      };
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }
  @Post('queue/resume')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'update')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Resume outbound call queue',
  })
  @ApiResponse({
    status: 200,
    description: 'Queue successfully resumed',
  })
  async resumeQueue() {
    try {
      const paused = await this.outboundCallQueue.isPaused();

      if (!paused) {
        return {
          success: true,
          paused: false,
          message: 'Outbound call queue is already running.',
        };
      }

      await this.outboundCallQueue.resume();

      return {
        success: true,
        paused: false,
        message: 'Outbound call queue resumed successfully.',
      };
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }
  @Get('queue/status')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Get complete outbound call queue status',
  })
  async getQueueStatus() {
    const queue = await this.outboundCallQueue.getStatus();

    const worker = this.outboundCallWorker.getStatus();

    let state: 'running' | 'paused' | 'degraded' | 'offline';

    if (!queue.redis.healthy) {
      state = 'offline';
    } else if (queue.paused) {
      state = 'paused';
    } else if (!worker.running) {
      state = 'degraded';
    } else {
      state = 'running';
    }

    return {
      state,

      acceptingCalls: state === 'running',

      queue,

      worker,

      timestamp: new Date().toISOString(),
    };
  }
  @Get('queue/jobs')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'List outbound call queue jobs',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'waiting', 'failed', 'completed', 'delayed', 'paused'],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 20,
  })
  async getQueueJobs(
    @Query('status') status?: JobType | JobType[],
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const safePage = Math.max(Number(page) || 1, 1);

    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    return this.outboundCallQueue.getJobs(status, safePage, safeLimit);
  }

  @Get('queue/jobs/:jobId')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Get outbound call queue job',
  })
  @ApiParam({
    name: 'jobId',
    description: 'Call queue job ID',
  })
  async getQueueJob(@Param('jobId') jobId: string) {
    const job = await this.outboundCallQueue.getJob(jobId);

    if (!job) {
      throw new BadRequestException(`Queue job ${jobId} not found.`);
    }

    return job;
  }

  @Post()
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Create a new outbound call' })
  @ApiBody({ type: MakeCallDto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. Retrying the same request with the same key replays onto the original ' +
      'call (dialed / queued / failed) instead of placing a second real call. Scoped to the ' +
      'authenticated company — ignored (not rejected) for unauthenticated requests.',
  })
  @ApiResponse({ status: 201, description: 'Call initiated' })
  @ApiResponse({
    status: 202,
    description: 'Call queued — every concurrent outbound slot is busy right now',
  })
  @UseGuards(TrustedOriginOrAttachUserGuard, MakeCallRateLimitGuard)
  async makeCall(
    @Body() dto: MakeCallDto,
    @Request() req: CallsAuthRequest,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ) {
    const origin = req.headers.origin;
    const originStr = typeof origin === 'string' ? origin : undefined;
    this.logger.debug(
      `Call request origin: ${originStr ?? '(none)'}, companyId: ${req.user?.companyId ?? '(none)'}`,
    );

    const callsCfg = this.configService.get<{
      frontendBaseUrl?: string;
      backendBaseUrl?: string;
    }>('calls');
    const trustedCaller = resolveTrustedCallerAttribution(req, dto, callsCfg ?? {});

    const u = req.user;
    if (u?.companyId) {
      if (
        u.isApiAuthenticated &&
        !checkApiKeyPermission(u.apiKeyPermissions ?? null, 'calls', 'create')
      ) {
        throw new ForbiddenException(
          'API key is not allowed to create calls. Grant `calls.create` or use a user session.',
        );
      }
      return this.enqueueAndRespond(dto, u.companyId, trustedCaller, idempotencyKeyHeader);
    }
    return this.enqueueAndRespond(dto, undefined, trustedCaller, idempotencyKeyHeader);
  }

  /**
   * Every outbound call — ad-hoc or bulk — goes through the same MAX_CONCURRENT_OUTBOUND_CALLS
   * gated queue, so one caller can never crowd out another and a burst of requests dials at most
   * N calls at once instead of serializing. In the common case (a free slot) this resolves in
   * milliseconds with the same {callSid, provider, ...} shape callers already expect; only when
   * every slot is busy does it fall back to a 202 "queued" response instead of blocking.
   *
   * An `Idempotency-Key` header, scoped to the caller's company, makes a retried request (client
   * timeout, double-submit) replay onto the same queued/dialed/completed job instead of placing
   * a second real call — see buildIdempotencyJobId for why scoping matters and why an
   * unauthenticated caller's key is safely ignored rather than rejected.
   */
  private async enqueueAndRespond(
    dto: MakeCallDto,
    companyId: string | undefined,
    trustedCaller: ReturnType<typeof resolveTrustedCallerAttribution>,
    idempotencyKeyHeader?: string,
  ) {
    try {
      const idempotencyKey = buildIdempotencyJobId(
        idempotencyKeyHeader,
        companyId ?? trustedCaller?.userId,
      );
      const result = await this.outboundCallQueue.enqueueAndAwaitDial(
        dto,
        companyId,
        trustedCaller,
        'api',
        idempotencyKey,
      );
      if (result.queued) {
        return {
          success: true,
          queued: true,
          callQueueId: result.callQueueId,
          message:
            'All outbound call slots are busy right now — this call is queued and will dial as soon as one frees up.',
        };
      }
      // Spread the underlying makeCall() result first so this response shape matches what
      // direct (non-queued) calls always returned (callSid, provider, twimlUrl, callState,
      // scriptUsed, ...); callQueueId is additive, not a replacement for any existing field.
      return { ...result.result, callQueueId: result.callQueueId };
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }

  @Get()
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'List all calls' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Filter by company ID' })
  getAllCalls(@Query('companyId') companyId: string | undefined, @Request() req: CallsAuthRequest) {
    const resolved = companyId ?? req.user?.companyId ?? undefined;
    const filterId = resolved ?? undefined;
    if (filterId) {
      return this.callsService.getAllCalls(filterId);
    }
    return this.callsService.getAllCalls();
  }

  @Get('stats')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'In-memory call state statistics' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Scope stats to a company' })
  getStats(@Query('companyId') companyId: string | undefined, @Request() req: CallsAuthRequest) {
    const resolved = companyId ?? req.user?.companyId ?? undefined;
    const filterId = resolved === '' ? undefined : resolved;
    return this.callsService.getStats(filterId);
  }

  @Get('records/:callSid')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({
    summary: 'Get persisted call record (database row: transcript, metadata, duration)',
  })
  @ApiParam({ name: 'callSid', description: 'Twilio Call SID' })
  @ApiResponse({ status: 404, description: 'No row for this SID' })
  async getPersistedCallRecord(
    @Param('callSid') callSid: string,
    @Request() req: CallsAuthRequest,
  ) {
    const u = req.user;
    if (!u || !('role' in u)) {
      throw new UnauthorizedException();
    }
    return this.callsService.getPersistedCallRecord(callSid, u as ValidatedUser);
  }

  @Get(':callSid')
  @UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
  @RequireApiKeyPermission('calls', 'read')
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Retrieve a call state by SID' })
  @ApiParam({
    name: 'callSid',
    description: 'Unique call SID returned by Twilio',
  })
  getCallState(@Param('callSid') callSid: string) {
    return this.callsService.getCallState(callSid);
  }
}
