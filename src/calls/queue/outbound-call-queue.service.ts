import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import * as crypto from 'crypto';
import { JobType, Queue, QueueEvents } from 'bullmq';

import callQueueConfig from '../../configs/call-queue.config';
import redisConfig from '../../configs/redis.config';
import { redisStatusSummary } from '../../common/utils/redis-logging.util';
import { withTimeout } from '../../common/utils/with-timeout.util';
import { buildRedisConnectionOptions } from '../../whatsapp/queues/redis-connection.util';
import type { MakeCallInput } from '../dto/make-call.dto';
import type { TrustedCallerAttribution } from '../utils/trusted-caller-attribution.util';
import {
  OUTBOUND_CALL_QUEUE,
  isOutboundCallProgress,
  type DialCallJobPayload,
  type OutboundCallJobResult,
} from './call-queue.types';

/**
 * Producer-side handle for the outbound call queue: enqueues jobs and lets callers observe
 * their lifecycle via BullMQ's Redis-backed QueueEvents (works from any app instance, not just
 * the one that happens to run the worker that eventually picks the job up — required for
 * horizontal scaling).
 */
@Injectable()
export class OutboundCallQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundCallQueueService.name);
  private queue: Queue<DialCallJobPayload, OutboundCallJobResult> | null = null;
  private queueEvents: QueueEvents | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    try {
      const queue = this.getQueue();
      const queueEvents = this.getQueueEvents();

      queue.on('error', (err: Error) => {
        this.logger.error(
          `[BullMQ:${OUTBOUND_CALL_QUEUE}:queue] Redis connection error: ${err.message}`,
        );
      });
      queueEvents.on('error', (err: Error) => {
        this.logger.error(
          `[BullMQ:${OUTBOUND_CALL_QUEUE}:queue-events] Redis connection error: ${err.message}`,
        );
      });

      queue
        .waitUntilReady()
        .then(() => {
          this.logger.log(`[BullMQ:${OUTBOUND_CALL_QUEUE}:queue] Redis connection ready`);
        })
        .catch((err: unknown) => {
          this.logger.error(
            `[BullMQ:${OUTBOUND_CALL_QUEUE}:queue] Failed to connect to Redis: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      queueEvents
        .waitUntilReady()
        .then(() => {
          this.logger.log(`[BullMQ:${OUTBOUND_CALL_QUEUE}:queue-events] Redis connection ready`);
        })
        .catch((err: unknown) => {
          this.logger.error(
            `[BullMQ:${OUTBOUND_CALL_QUEUE}:queue-events] Failed to connect to Redis: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      this.logger.warn(`Outbound call queue init deferred: ${(err as Error).message}`);
    }
  }

  // /** Current Redis/queue health — the single source of truth for "is the outbound call queue
  //  *  actually working right now" (used by the /calls/queue/health endpoint). */
  // async getStatus(): Promise<{
  //   redis: { status: string; healthy: boolean };
  //   activeCount: number;
  //   waitingCount: number;
  //   delayedCount: number;
  // }> {
  //   const queue = this.getQueue();
  //   try {
  //     const { client, activeCount, waitingCount, delayedCount } = await withTimeout(
  //       (async () => {
  //         const c = await queue.client;
  //         const [active, waiting, delayed] = await Promise.all([
  //           queue.getActiveCount(),
  //           queue.getWaitingCount(),
  //           queue.getDelayedCount(),
  //         ]);
  //         return { client: c, activeCount: active, waitingCount: waiting, delayedCount: delayed };
  //       })(),
  //       this.cfg().redisOpTimeoutMs,
  //       'getStatus',
  //     );
  //     return { redis: redisStatusSummary(client), activeCount, waitingCount, delayedCount };
  //   } catch (err) {
  //     this.logger.warn(`getStatus failed: ${err instanceof Error ? err.message : String(err)}`);
  //     return {
  //       redis: { status: 'error', healthy: false },
  //       activeCount: -1,
  //       waitingCount: -1,
  //       delayedCount: -1,
  //     };
  //   }
  // }

  async getStatus(): Promise<{
    queueName: string;

    redis: {
      status: string;
      healthy: boolean;
    };

    paused: boolean;

    counts: {
      active: number;
      waiting: number;
      delayed: number;
      failed: number;
      completed: number;
      paused: number;
    };
  }> {
    const queue = this.getQueue();

    try {
      return await withTimeout(
        (async () => {
          const client = await queue.client;

          const [paused, active, waiting, delayed, failed, completed, pausedCount] =
            await Promise.all([
              queue.isPaused(),
              queue.getActiveCount(),
              queue.getWaitingCount(),
              queue.getDelayedCount(),
              queue.getFailedCount(),
              queue.getCompletedCount(),
              queue.getJobCountByTypes('paused'),
            ]);

          return {
            queueName: OUTBOUND_CALL_QUEUE,

            redis: redisStatusSummary(client),

            paused,

            counts: {
              active,
              waiting,
              delayed,
              failed,
              completed,
              paused: pausedCount,
            },
          };
        })(),

        this.cfg().redisOpTimeoutMs,

        'getStatus',
      );
    } catch (err) {
      this.logger.warn(`getStatus failed: ${err instanceof Error ? err.message : String(err)}`);

      return {
        queueName: OUTBOUND_CALL_QUEUE,

        redis: {
          status: 'error',
          healthy: false,
        },

        paused: false,

        counts: {
          active: -1,
          waiting: -1,
          delayed: -1,
          failed: -1,
          completed: -1,
          paused: -1,
        },
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Bounded: BullMQ's close() still needs its Redis connection to shut down cleanly, which can
    // stall if Redis is unreachable at shutdown time — must not hang the whole app's shutdown.
    const timeoutMs = this.cfg().redisOpTimeoutMs;
    await withTimeout(
      Promise.resolve(this.queueEvents?.close()),
      timeoutMs,
      'queueEvents close',
    ).catch(() => undefined);
    await withTimeout(Promise.resolve(this.queue?.close()), timeoutMs, 'queue close').catch(
      () => undefined,
    );
  }

  private connectionOptions() {
    const rc = this.configService.get<ConfigType<typeof redisConfig>>('redis');
    return buildRedisConnectionOptions({
      host: rc?.host,
      port: rc?.port,
      password: rc?.password,
    });
  }

  private cfg(): ConfigType<typeof callQueueConfig> {
    return (
      this.configService.get<ConfigType<typeof callQueueConfig>>('callQueue') ?? {
        maxConcurrentCalls: 50,
        maxConcurrentOutboundCalls: 10,
        maxConcurrentInboundCalls: 20,
        dialRateLimitPerWindow: 5,
        dialRateLimitWindowMs: 1000,
        retryLimit: 2,
        retryBackoffMs: 5000,
        callTimeoutMs: 10 * 60 * 1000,
        callStatusPollIntervalMs: 2000,
        dialAckTimeoutMs: 30_000,
        lockDurationMs: 30_000,
        stalledIntervalMs: 30_000,
        redisOpTimeoutMs: 2_000,
      }
    );
  }

  getQueue(): Queue<DialCallJobPayload, OutboundCallJobResult> {
    this.queue ??= new Queue(OUTBOUND_CALL_QUEUE, {
      connection: this.connectionOptions(),
      defaultJobOptions: {
        attempts: this.cfg().retryLimit,
        backoff: { type: 'exponential', delay: this.cfg().retryBackoffMs },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400, count: 5000 },
      },
    });
    return this.queue;
  }

  getQueueEvents(): QueueEvents {
    this.queueEvents ??= new QueueEvents(OUTBOUND_CALL_QUEUE, {
      connection: this.connectionOptions(),
    });
    return this.queueEvents;
  }

  /**
   * Enqueues one ad-hoc/campaign outbound call and waits only until the queue reports the dial
   * itself succeeded or failed (NOT until the whole call ends) — matches the existing `POST
   * /calls` contract of returning a `callSid` promptly. The call keeps running (and keeps the
   * worker's concurrency slot occupied) after this resolves; use `waitForCompletion` if the
   * full lifecycle result is needed (e.g. campaign bookkeeping).
   *
   * If every worker slot is busy, this call sits queued behind others — no different provider
   * dial happens until MAX_CONCURRENT_OUTBOUND_CALLS makes room. If the wait exceeds
   * `dialAckTimeoutMs` (still queued), resolves with `queued: true` instead of blocking the HTTP
   * request indefinitely — callers can poll status via the callQueueId.
   *
   * `idempotencyKey`, when provided, becomes the BullMQ jobId (instead of a fresh UUID) so a
   * retried request (client timeout, double-submit) replays onto the SAME job rather than
   * placing a second real call. Verified empirically: `queue.add()` with an already-existing
   * jobId is a safe no-op — it never creates a duplicate queue entry and never causes the job to
   * be reprocessed, even after the original job has already completed or failed. This method
   * detects that replay case (job already dialed / already permanently failed / already
   * exhausted its retries) and returns/throws the ORIGINAL outcome immediately, rather than
   * waiting on events that already fired before this call attached its listeners.
   */
  async enqueueAndAwaitDial(
    dto: MakeCallInput,
    companyId: string | undefined,
    trustedCaller: TrustedCallerAttribution | undefined,
    source: DialCallJobPayload['source'] = 'api',
    idempotencyKey?: string,
  ): Promise<
    | {
        queued: false;
        callQueueId: string;
        callSid: string;
        provider: string;
        result: Record<string, unknown>;
      }
    | { queued: true; callQueueId: string }
  > {
    const callQueueId = idempotencyKey ?? crypto.randomUUID();
    const payload: DialCallJobPayload = {
      kind: 'dial-call',
      callQueueId,
      dto,
      companyId,
      trustedCaller,
      source,
    };

    const queue = this.getQueue();
    const addedJob = await withTimeout(
      queue.add('dial-call', payload, { jobId: callQueueId }),
      this.cfg().redisOpTimeoutMs,
      'enqueue',
    );
    this.logger.log(
      `[callId=${callQueueId}] Queued outbound call to ${dto.to} (source=${source}` +
        `${idempotencyKey ? ', idempotencyKey=' + idempotencyKey : ''})`,
    );

    // IMPORTANT: when `jobId` already exists, queue.add() returns a LOCALLY-CONSTRUCTED Job
    // carrying only the id — its `.progress`/`.data` reflect what THIS call attempted to write,
    // not the real current state of the existing job in Redis (verified empirically: a completed
    // job's progress read back as `0` from the add() return value, vs. the correct persisted
    // value from a fresh queue.getJob()). Only an idempotency-key replay can ever hit a
    // pre-existing job, so only pay for the extra Redis round trip on that path — a freshly
    // generated UUID can never collide, so the common case stays as fast as before.
    const job = idempotencyKey
      ? ((await withTimeout(queue.getJob(callQueueId), this.cfg().redisOpTimeoutMs, 'getJob')) ??
        addedJob)
      : addedJob;

    // Replay / already-progressed fast path — see method doc. Must run BEFORE attaching event
    // listeners: a replayed idempotency key's job may have settled (dialed, permanently failed,
    // or exhausted retries) well before this call, so no future event will ever fire for it.
    if (idempotencyKey) {
      const progress = job.progress;
      if (isOutboundCallProgress(progress)) {
        if (progress.phase === 'dialed') {
          this.logger.log(`[callId=${progress.callSid}] Already dialed (queueId=${callQueueId})`);
          return {
            queued: false,
            callQueueId,
            callSid: progress.callSid,
            provider: progress.provider,
            result: progress.result,
          };
        }
        if (progress.phase === 'dial-failed' && progress.permanent) {
          throw new Error(progress.error);
        }
      }
      if (await job.isFailed()) {
        throw new Error(job.failedReason || 'Call failed');
      }
    }

    const events = this.getQueueEvents();
    const dialAckTimeoutMs = this.cfg().dialAckTimeoutMs;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        events.off('progress', onProgress);
        events.off('failed', onFailed);
      };
      const finish = (
        outcome:
          | {
              queued: false;
              callQueueId: string;
              callSid: string;
              provider: string;
              result: Record<string, unknown>;
            }
          | { queued: true; callQueueId: string },
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(message));
      };

      const onProgress: (args: { jobId: string; data: unknown }) => void = ({ jobId, data }) => {
        if (jobId !== job.id || !isOutboundCallProgress(data)) return;
        if (data.phase === 'dialed') {
          this.logger.log(`[callId=${data.callSid}] Dial acknowledged (queueId=${callQueueId})`);
          finish({
            queued: false,
            callQueueId,
            callSid: data.callSid,
            provider: data.provider,
            result: data.result,
          });
        } else if (data.phase === 'dial-failed' && data.permanent) {
          // Permanent failures never retry — the job resolves (not fails) so this is the only
          // signal; surface it to the waiting caller immediately instead of waiting on a timeout.
          fail(data.error);
        }
      };
      // Transient failures exhaust BullMQ's retry attempts and the job ultimately fails — that's
      // the only path left for those (permanent failures already reject via 'progress' above).
      const onFailed: (args: { jobId: string; failedReason: string }) => void = ({
        jobId,
        failedReason,
      }) => {
        if (jobId !== job.id) return;
        fail(failedReason);
      };

      events.on('progress', onProgress);
      events.on('failed', onFailed);

      const timer = setTimeout(() => {
        this.logger.log(
          `[callId=${callQueueId}] Still queued after ${String(dialAckTimeoutMs)}ms — worker capacity is full; caller should poll status`,
        );
        finish({ queued: true, callQueueId });
      }, dialAckTimeoutMs);

      // Zero-cost final check (no extra Redis round trip — reuses the `job` object already in
      // hand): covers the tiny race where the worker dialed and updated progress in the moment
      // between `queue.add()` returning and these listeners attaching, so that update's event
      // already fired and would otherwise never be observed.
      const currentProgress = job.progress;
      if (isOutboundCallProgress(currentProgress) && currentProgress.phase === 'dialed') {
        finish({
          queued: false,
          callQueueId,
          callSid: currentProgress.callSid,
          provider: currentProgress.provider,
          result: currentProgress.result,
        });
      }
    });
  }

  /** Enqueues a call without waiting on it at all — pair with `waitForCompletion` for bulk/
   *  campaign flows that want each call's full outcome once it ends, run fully concurrently
   *  (bounded only by MAX_CONCURRENT_OUTBOUND_CALLS), instead of a one-call-at-a-time loop. */
  async enqueue(
    dto: MakeCallInput,
    companyId: string | undefined,
    trustedCaller: TrustedCallerAttribution | undefined,
    source: DialCallJobPayload['source'],
  ): Promise<string> {
    const callQueueId = crypto.randomUUID();
    const payload: DialCallJobPayload = {
      kind: 'dial-call',
      callQueueId,
      dto,
      companyId,
      trustedCaller,
      source,
    };
    await withTimeout(
      this.getQueue().add('dial-call', payload, { jobId: callQueueId }),
      this.cfg().redisOpTimeoutMs,
      'enqueue',
    );
    this.logger.log(`[callId=${callQueueId}] Queued outbound call to ${dto.to} (source=${source})`);
    return callQueueId;
  }

  /** Waits for a queued job's full lifecycle (dial + call ended) to finish. Cross-instance safe
   *  (backed by Redis via QueueEvents) — use for bulk/campaign flows that need per-call outcomes
   *  without polling. */
  async waitForCompletion(callQueueId: string, timeoutMs: number): Promise<OutboundCallJobResult> {
    const queue = this.getQueue();
    const job = await queue.getJob(callQueueId);
    if (!job) {
      return { outcome: 'failed', error: `Job ${callQueueId} not found` };
    }
    try {
      return await job.waitUntilFinished(this.getQueueEvents(), timeoutMs);
    } catch (err) {
      return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getActiveCount(): Promise<number> {
    return withTimeout(
      this.getQueue().getActiveCount(),
      this.cfg().redisOpTimeoutMs,
      'getActiveCount',
    );
  }

  async getWaitingCount(): Promise<number> {
    return withTimeout(
      this.getQueue().getWaitingCount(),
      this.cfg().redisOpTimeoutMs,
      'getWaitingCount',
    );
  }

  /**
   * Globally pauses the queue.
   *
   * Important:
   * - Active calls continue until completion.
   * - Waiting/new jobs stay queued.
   * - Works across every worker/app instance using this BullMQ queue.
   */
  async pause(): Promise<void> {
    await withTimeout(this.getQueue().pause(), this.cfg().redisOpTimeoutMs, 'pause queue');

    this.logger.warn(`[BullMQ:${OUTBOUND_CALL_QUEUE}] Outbound queue paused`);
  }

  /**
   * Globally resumes processing.
   */
  async resume(): Promise<void> {
    await withTimeout(this.getQueue().resume(), this.cfg().redisOpTimeoutMs, 'resume queue');

    this.logger.log(`[BullMQ:${OUTBOUND_CALL_QUEUE}] Outbound queue resumed`);
  }

  async isPaused(): Promise<boolean> {
    return withTimeout(this.getQueue().isPaused(), this.cfg().redisOpTimeoutMs, 'isPaused');
  }

  async getJobs(status?: JobType | JobType[], page = 1, limit = 20) {
    const queue = this.getQueue();

    const allowedStatuses = [
      'active',
      'waiting',
      'completed',
      'failed',
      'delayed',
      'paused',
    ] as const;

    const statuses =
      status && allowedStatuses.includes(status as (typeof allowedStatuses)[number])
        ? [status]
        : ['active', 'waiting', 'delayed', 'failed'];

    const start = (Math.max(page, 1) - 1) * limit;

    const end = start + limit - 1;

    const jobs = await queue.getJobs(statuses as any, start, end, false);

    const data = await Promise.all(
      jobs.map(async job => ({
        id: job.id,

        callQueueId: job.data.callQueueId,

        state: await job.getState(),

        phoneNumber: job.data.dto?.to,

        companyId: job.data.companyId,

        source: job.data.source,

        progress: job.progress,

        attemptsMade: job.attemptsMade,

        maxAttempts: job.opts.attempts,

        failedReason: job.failedReason,

        result: job.returnvalue,

        createdAt: job.timestamp,

        processedAt: job.processedOn,

        finishedAt: job.finishedOn,
      })),
    );

    return {
      page,
      limit,
      jobs: data,
    };
  }

  async getJob(callQueueId: string) {
    const job = await withTimeout(
      this.getQueue().getJob(callQueueId),
      this.cfg().redisOpTimeoutMs,
      'getJob',
    );

    if (!job) {
      return null;
    }

    const state = await job.getState();

    return {
      id: job.id,

      state,

      data: {
        callQueueId: job.data.callQueueId,
        phoneNumber: job.data.dto.to,
        source: job.data.source,
        companyId: job.data.companyId,
      },

      progress: job.progress,

      result: job.returnvalue,

      attemptsMade: job.attemptsMade,

      maxAttempts: job.opts.attempts,

      failedReason: job.failedReason,

      timestamp: job.timestamp,

      processedOn: job.processedOn,

      finishedOn: job.finishedOn,
    };
  }

  async retryJob(callQueueId: string): Promise<void> {
    const job = await this.getQueue().getJob(callQueueId);

    if (!job) {
      throw new Error(`Queue job ${callQueueId} not found`);
    }

    const state = await job.getState();

    if (state !== 'failed') {
      throw new Error(`Cannot retry job ${callQueueId}. Current state is "${state}".`);
    }

    await withTimeout(job.retry(), this.cfg().redisOpTimeoutMs, 'retryJob');

    this.logger.log(`[callId=${callQueueId}] Failed queue job manually retried`);
  }

  async retryFailedJobs(count = 100): Promise<void> {
    await withTimeout(
      this.getQueue().retryJobs({
        count,
        state: 'failed',
      }),
      this.cfg().redisOpTimeoutMs,
      'retryFailedJobs',
    );

    this.logger.warn(`[BullMQ:${OUTBOUND_CALL_QUEUE}] Admin requested retry of failed jobs`);
  }

  async removeJob(callQueueId: string): Promise<void> {
    const job = await this.getQueue().getJob(callQueueId);

    if (!job) {
      throw new Error(`Queue job ${callQueueId} not found`);
    }

    const state = await job.getState();

    if (state === 'active') {
      throw new Error('Active call jobs cannot be removed. End/cancel the actual call first.');
    }

    await withTimeout(job.remove(), this.cfg().redisOpTimeoutMs, 'removeJob');

    this.logger.warn(`[callId=${callQueueId}] Queue job removed by admin`);
  }

  async getHealth() {
    const queue = this.getQueue();

    try {
      const [paused, active, waiting, failed, delayed, workers] = await withTimeout(
        Promise.all([
          queue.isPaused(),
          queue.getActiveCount(),
          queue.getWaitingCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
          queue.getWorkers().catch(() => []),
        ]),
        this.cfg().redisOpTimeoutMs,
        'queue health',
      );

      const client = await queue.client;
      const redis = redisStatusSummary(client);

      return {
        healthy: redis.healthy && workers.length > 0,

        queue: OUTBOUND_CALL_QUEUE,

        redis,

        paused,

        workers: workers.length,

        jobs: {
          active,
          waiting,
          failed,
          delayed,
        },

        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        healthy: false,
        queue: OUTBOUND_CALL_QUEUE,

        redis: {
          healthy: false,
          status: 'error',
        },

        paused: false,

        workers: 0,

        error: error instanceof Error ? error.message : String(error),

        timestamp: new Date().toISOString(),
      };
    }
  }

  async getMetrics() {
    const queue = this.getQueue();
    const cfg = this.cfg();

    try {
      const result = await withTimeout(
        (async () => {
          const [
            active,
            waiting,
            delayed,
            failed,
            completed,
            paused,
            workers,
            waitingJobs,
            completedJobs,
            failedJobs,
          ] = await Promise.all([
            queue.getActiveCount(),
            queue.getWaitingCount(),
            queue.getDelayedCount(),
            queue.getFailedCount(),
            queue.getCompletedCount(),
            queue.isPaused(),
            queue.getWorkers().catch(() => []),

            // Keep these bounded. Do not fetch the entire history.
            queue.getWaiting(0, 99),
            queue.getCompleted(0, 99),
            queue.getFailed(0, 99),
          ]);

          return {
            active,
            waiting,
            delayed,
            failed,
            completed,
            paused,
            workers,
            waitingJobs,
            completedJobs,
            failedJobs,
          };
        })(),
        cfg.redisOpTimeoutMs,
        'getQueueMetrics',
      );

      const maxConcurrency =
        cfg.maxConcurrentOutboundCalls;

      const availableSlots = Math.max(
        maxConcurrency - result.active,
        0,
      );

      const utilizationPercent =
        maxConcurrency > 0
          ? Number(
            (
              (result.active / maxConcurrency) *
              100
            ).toFixed(2),
          )
          : 0;

      const now = Date.now();

      /*
       * WAIT TIME
       *
       * processedOn - timestamp
       *
       * timestamp:
       *   when job was added
       *
       * processedOn:
       *   when worker started processing
       */
      const startedJobs = [
        ...result.completedJobs,
        ...result.failedJobs,
      ].filter(
        job =>
          typeof job.processedOn === 'number',
      );

      const waitTimes = startedJobs
        .map(job => {
          if (
            typeof job.processedOn !== 'number' ||
            typeof job.timestamp !== 'number'
          ) {
            return null;
          }

          return Math.max(
            job.processedOn - job.timestamp,
            0,
          );
        })
        .filter(
          (value): value is number =>
            value !== null,
        );

      const averageWaitTimeMs =
        this.average(waitTimes);

      /*
       * PROCESSING TIME
       *
       * finishedOn - processedOn
       */
      const processingTimes = [
        ...result.completedJobs,
        ...result.failedJobs,
      ]
        .map(job => {
          if (
            typeof job.processedOn !== 'number' ||
            typeof job.finishedOn !== 'number'
          ) {
            return null;
          }

          return Math.max(
            job.finishedOn -
            job.processedOn,
            0,
          );
        })
        .filter(
          (value): value is number =>
            value !== null,
        );

      const averageProcessingTimeMs =
        this.average(processingTimes);

      /*
       * OLDEST WAITING JOB
       */
      const oldestWaitingTimestamp =
        result.waitingJobs.reduce<
          number | null
        >((oldest, job) => {
          if (
            typeof job.timestamp !== 'number'
          ) {
            return oldest;
          }

          if (
            oldest === null ||
            job.timestamp < oldest
          ) {
            return job.timestamp;
          }

          return oldest;
        }, null);

      const oldestWaitingJobMs =
        oldestWaitingTimestamp !== null
          ? Math.max(
            now - oldestWaitingTimestamp,
            0,
          )
          : 0;

      /*
       * These are BullMQ retained counts.
       *
       * Your removeOnComplete/removeOnFail rules mean
       * these represent currently retained historical jobs,
       * not necessarily lifetime call totals.
       */
      const totalSettled =
        result.completed + result.failed;

      const successRatePercent =
        totalSettled > 0
          ? Number(
            (
              (result.completed /
                totalSettled) *
              100
            ).toFixed(2),
          )
          : 100;

      let state:
        | 'running'
        | 'paused'
        | 'degraded';

      if (result.paused) {
        state = 'paused';
      } else if (
        result.workers.length === 0
      ) {
        state = 'degraded';
      } else {
        state = 'running';
      }

      return {
        queue: OUTBOUND_CALL_QUEUE,

        state,

        paused: result.paused,

        workers:
        result.workers.length,

        concurrency:
        maxConcurrency,

        counts: {
          active: result.active,
          waiting: result.waiting,
          delayed: result.delayed,
          failed: result.failed,
          completed: result.completed,
        },

        capacity: {
          used: result.active,
          max: maxConcurrency,
          availableSlots,
          utilizationPercent,
        },

        performance: {
          averageWaitTimeMs,
          averageProcessingTimeMs,
          oldestWaitingJobMs,
        },

        calls: {
          completed: result.completed,
          failed: result.failed,
          successRatePercent,
        },

        sampledJobs: {
          waiting:
          result.waitingJobs.length,
          settled:
          startedJobs.length,
        },

        timestamp:
          new Date().toISOString(),
      };
    } catch (err) {
      this.logger.warn(
        `getMetrics failed: ${
          err instanceof Error
            ? err.message
            : String(err)
        }`,
      );

      throw err;
    }
  }

  private average(
    values: number[],
  ): number {
    if (values.length === 0) {
      return 0;
    }

    return Math.round(
      values.reduce(
        (sum, value) =>
          sum + value,
        0,
      ) / values.length,
    );
  }
}
