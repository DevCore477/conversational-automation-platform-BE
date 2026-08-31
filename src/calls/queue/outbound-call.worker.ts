import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';

import callQueueConfig from '../../configs/call-queue.config';
import redisConfig from '../../configs/redis.config';
import { buildRedisConnectionOptions } from '../../whatsapp/queues/redis-connection.util';
import { withTimeout } from '../../common/utils/with-timeout.util';
import { classifyDialFailure, classifyProviderStatus } from '../utils/call-outcome.util';
import { CallsService } from '../calls.service';
import {
  OUTBOUND_CALL_QUEUE,
  isOutboundCallProgress,
  type DialCallJobPayload,
  type OutboundCallJobResult,
} from './call-queue.types';

/**
 * Consumes the outbound-call queue. `concurrency` here IS the "max simultaneous active calls"
 * dial (MAX_CONCURRENT_OUTBOUND_CALLS) — a job holds its worker slot for the call's entire
 * lifecycle (dial through terminal status), not just the dial request, so N concurrent jobs
 * means N calls genuinely ringing/active at once, capped exactly the way a dialer's concurrency
 * setting is expected to behave. Every job is fully independent: one call failing, timing out,
 * or throwing never touches another job's promise, Worker slot, or call state.
 */
@Injectable()
export class OutboundCallWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundCallWorker.name);
  private worker: Worker<DialCallJobPayload, OutboundCallJobResult> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly callsService: CallsService,
  ) {}

  onModuleInit(): void {
    const rc = this.configService.get<ConfigType<typeof redisConfig>>('redis');
    const connection = buildRedisConnectionOptions({
      host: rc?.host,
      port: rc?.port,
      password: rc?.password,
    });
    const cfg = this.configService.get<ConfigType<typeof callQueueConfig>>('callQueue');
    const concurrency = cfg?.maxConcurrentOutboundCalls ?? 10;

    this.worker = new Worker<DialCallJobPayload, OutboundCallJobResult>(
      OUTBOUND_CALL_QUEUE,
      job => this.process(job),
      {
        connection,
        concurrency,
        limiter: {
          max: cfg?.dialRateLimitPerWindow ?? 5,
          duration: cfg?.dialRateLimitWindowMs ?? 1000,
        },
        lockDuration: cfg?.lockDurationMs ?? 30_000,
        stalledInterval: cfg?.stalledIntervalMs ?? 30_000,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.warn(
        `[callId=${job?.data.callQueueId ?? 'unknown'}] Job failed (attempt ${String(job?.attemptsMade ?? 0)}/${String(job?.opts.attempts ?? 1)}): ${err.message}`,
      );
    });

    this.worker.on('error', (err: Error) => {
      this.logger.error(
        `[BullMQ:${OUTBOUND_CALL_QUEUE}:worker] Redis connection error: ${err.message}`,
      );
    });
    this.worker.on('ready', () => {
      this.logger.log(
        `[BullMQ:${OUTBOUND_CALL_QUEUE}:worker] Redis connection ready — polling for jobs`,
      );
    });
    this.worker.on('closing', (msg: string) => {
      this.logger.warn(`[BullMQ:${OUTBOUND_CALL_QUEUE}:worker] Closing: ${msg}`);
    });

    this.logger.log(
      `Outbound call worker started — concurrency=${String(concurrency)}, dial rate limit=${String(cfg?.dialRateLimitPerWindow ?? 5)}/${String(cfg?.dialRateLimitWindowMs ?? 1000)}ms`,
    );
  }

  // /** Current worker health — the worker is what actually consumes jobs, so a queue that looks
  //  *  healthy (Redis reachable) with a dead/closing worker would still never dial anything. */
  // getStatus(): { running: boolean; closing: boolean } {
  //   return {
  //     running: this.worker?.isRunning() ?? false,
  //     closing: this.worker?.closing != null,
  //   };
  // }

  getStatus(): {
    initialized: boolean;
    running: boolean;
    closing: boolean;
    concurrency: number;
  } {
    const cfg = this.configService.get<ConfigType<typeof callQueueConfig>>('callQueue');

    return {
      initialized: this.worker !== null,

      running: this.worker?.isRunning() ?? false,

      closing: this.worker?.closing != null,

      concurrency: cfg?.maxConcurrentOutboundCalls ?? 10,
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.worker) return;
    const cfg = this.configService.get<ConfigType<typeof callQueueConfig>>('callQueue');
    try {
      // Bounded for the same reason as InboundCallAdmissionService's shutdown: close() needs
      // Redis to shut down cleanly and can stall if Redis is unreachable at shutdown time.
      await withTimeout(this.worker.close(), cfg?.redisOpTimeoutMs ?? 2000, 'worker close');
    } catch {
      await this.worker.close(true).catch(() => undefined);
    }
  }

  private async process(job: Job<DialCallJobPayload>): Promise<OutboundCallJobResult> {
    const { callQueueId, dto, companyId, trustedCaller, source } = job.data;
    const cfg = this.configService.get<ConfigType<typeof callQueueConfig>>('callQueue');

    // CRASH-RECOVERY GUARD: if a prior attempt at THIS job already dialed successfully (recorded
    // via job.updateProgress, which survives BullMQ's stalled-job requeue — the job is moved back
    // to `wait` and reprocessed, but its persisted progress/data is not cleared), resume from that
    // callSid instead of re-dialing. Telephony dial APIs are not idempotent: without this guard, a
    // worker crash (process killed, OOM, deploy) mid-call causes the reassigned job to call
    // makeCall() again and place a second real phone call to the same number. Verified via a
    // dedicated crash-recovery test that reproduces the duplicate dial without this guard.
    const priorProgress = job.progress;
    if (isOutboundCallProgress(priorProgress) && priorProgress.phase === 'dialed') {
      this.logger.warn(
        `[callId=${priorProgress.callSid}] Resuming after worker crash/stall recovery — ` +
          `already dialed in a prior attempt, skipping re-dial to avoid a duplicate call`,
      );
      return this.waitForCallOutcome(priorProgress.callSid, cfg);
    }

    this.logger.log(
      `[callId=${callQueueId}] Dequeued (source=${source}, attempt ${String(job.attemptsMade + 1)}/${String(job.opts.attempts ?? 1)}) — dialing ${dto.to}`,
    );
    await job.updateProgress({ phase: 'dialing' });

    let dialResult: { callSid: string; provider: string; result: Record<string, unknown> };
    try {
      const result = await this.callsService.makeCall(dto, companyId, trustedCaller);
      const resultRecord = result as unknown as Record<string, unknown>;
      dialResult = {
        callSid: result.callSid,
        provider: 'provider' in result && result.provider ? result.provider : 'local-terminal-ai',
        result: resultRecord,
      };
    } catch (err) {
      const { permanent, reason } = classifyDialFailure(err);
      this.logger.warn(
        `[callId=${callQueueId}] Dial failed (${permanent ? 'permanent — will not retry' : 'transient — may retry'}): ${reason}`,
      );
      await job.updateProgress({ phase: 'dial-failed', error: reason, permanent });
      if (permanent) {
        // Resolve the job (do not throw) so BullMQ never retries a number that will never answer.
        return { outcome: 'dial_failed', error: reason };
      }
      // Let BullMQ's attempts/backoff (CALL_QUEUE_RETRY_LIMIT / CALL_QUEUE_RETRY_BACKOFF_MS) retry.
      throw err;
    }

    const { callSid, provider, result } = dialResult;
    this.logger.log(`[callId=${callSid}] Dial succeeded (provider=${provider}) — call in progress`);
    await job.updateProgress({ phase: 'dialed', callSid, provider, result });

    return this.waitForCallOutcome(callSid, cfg);
  }

  /** Polls provider status until the call reaches a terminal state (or CALL_TIMEOUT_MS). Shared
   *  by the normal dial path and the crash-recovery resume path (which skips straight here
   *  without re-dialing). */
  private async waitForCallOutcome(
    callSid: string,
    cfg: ConfigType<typeof callQueueConfig> | undefined,
  ): Promise<OutboundCallJobResult> {
    const finalProviderStatus = await this.callsService.waitForCallToEnd(callSid, {
      pollIntervalMs: cfg?.callStatusPollIntervalMs ?? 2000,
      timeoutMs: cfg?.callTimeoutMs ?? 10 * 60 * 1000,
    });

    if (finalProviderStatus === undefined) {
      this.logger.warn(`[callId=${callSid}] Call did not reach a terminal status before timeout`);
      return { callSid, outcome: 'timeout' };
    }

    const outcome = classifyProviderStatus(finalProviderStatus) ?? 'failed';
    this.logger.log(`[callId=${callSid}] Call ended: ${finalProviderStatus} (outcome=${outcome})`);
    return { callSid, outcome, providerStatus: finalProviderStatus };
  }
}
