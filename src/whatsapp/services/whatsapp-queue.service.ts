import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { hostname } from 'os';
import { DataSource, In, Repository } from 'typeorm';

import { WhatsAppJobStatus, WhatsAppJobType } from '../../common/enums/whatsapp.enum';
import whatsappConfig from '../../configs/whatsapp.config';
import { WhatsAppJob } from '../../models/whatsapp/whatsapp-job.entity';

export interface EnqueueJobParams {
  jobType: WhatsAppJobType;
  payload: Record<string, unknown>;
  conversationId?: string | null;
  campaignId?: string | null;
  dedupeKey?: string | null;
  priority?: number;
  scheduledAt?: Date;
  maxAttempts?: number;
}

@Injectable()
export class WhatsAppQueueService {
  private readonly logger = new Logger(WhatsAppQueueService.name);
  private readonly workerId: string;

  constructor(
    @InjectRepository(WhatsAppJob)
    private readonly jobRepo: Repository<WhatsAppJob>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    const cfg = this.configService.get<ConfigType<typeof whatsappConfig>>('whatsapp');
    this.workerId = cfg?.queueWorkerId ?? hostname();
  }

  async enqueue(params: EnqueueJobParams): Promise<WhatsAppJob> {
    if (params.dedupeKey) {
      await this.jobRepo.update(
        {
          dedupeKey: params.dedupeKey,
          status: In([WhatsAppJobStatus.PENDING, WhatsAppJobStatus.PROCESSING]),
        },
        { status: WhatsAppJobStatus.CANCELLED, completedAt: new Date() },
      );
    }

    const job = this.jobRepo.create({
      jobType: params.jobType,
      payload: params.payload,
      conversationId: params.conversationId ?? null,
      campaignId: params.campaignId ?? null,
      dedupeKey: params.dedupeKey ?? null,
      priority: params.priority ?? 0,
      scheduledAt: params.scheduledAt ?? new Date(),
      maxAttempts: params.maxAttempts ?? 5,
      status: WhatsAppJobStatus.PENDING,
    });

    return this.jobRepo.save(job);
  }

  async enqueueMany(items: EnqueueJobParams[]): Promise<WhatsAppJob[]> {
    const jobs = items.map(p =>
      this.jobRepo.create({
        jobType: p.jobType,
        payload: p.payload,
        conversationId: p.conversationId ?? null,
        campaignId: p.campaignId ?? null,
        dedupeKey: p.dedupeKey ?? null,
        priority: p.priority ?? 0,
        scheduledAt: p.scheduledAt ?? new Date(),
        maxAttempts: p.maxAttempts ?? 5,
        status: WhatsAppJobStatus.PENDING,
      }),
    );
    return this.jobRepo.save(jobs);
  }

  /**
   * Claim jobs with per-conversation exclusivity: never run two jobs for the same
   * conversationId concurrently.
   */
  async claimBatch(limit: number): Promise<WhatsAppJob[]> {
    return this.dataSource.transaction(async manager => {
      const rows: WhatsAppJob[] = await manager.query(
        `
        SELECT j.*
        FROM whatsapp_jobs j
        WHERE j.status IN ('pending', 'failed')
          AND j."scheduledAt" <= NOW()
          AND j.attempts < j."maxAttempts"
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_jobs j2
            WHERE j2."conversationId" IS NOT NULL
              AND j2."conversationId" = j."conversationId"
              AND j2.status = 'processing'
          )
        ORDER BY j.priority DESC, j."scheduledAt" ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
        `,
        [limit],
      );

      if (rows.length === 0) {
        return [];
      }

      const ids = rows.map((r: WhatsAppJob) => r.id);
      for (const id of ids) {
        await manager.increment(WhatsAppJob, { id }, 'attempts', 1);
      }
      await manager.update(
        WhatsAppJob,
        { id: In(ids) },
        {
          status: WhatsAppJobStatus.PROCESSING,
          lockedAt: new Date(),
          lockedBy: this.workerId,
        },
      );

      return manager.find(WhatsAppJob, { where: { id: In(ids) } });
    });
  }

  async complete(jobId: string): Promise<void> {
    await this.jobRepo.update(jobId, {
      status: WhatsAppJobStatus.COMPLETED,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    });
  }

  async fail(jobId: string, error: string, retryDelayMs: number): Promise<void> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      return;
    }

    const exhausted = job.attempts >= job.maxAttempts;
    const nextRun = new Date(Date.now() + retryDelayMs);

    await this.jobRepo.update(jobId, {
      status: exhausted ? WhatsAppJobStatus.FAILED : WhatsAppJobStatus.PENDING,
      lastError: error.slice(0, 2000),
      scheduledAt: exhausted ? job.scheduledAt : nextRun,
      lockedAt: null,
      lockedBy: null,
      completedAt: exhausted ? new Date() : null,
    });
  }

  async getCampaignStats(campaignId: string) {
    const raw = await this.jobRepo
      .createQueryBuilder('j')
      .select('j.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('j.campaignId = :campaignId', { campaignId })
      .groupBy('j.status')
      .getRawMany<{ status: string; count: string }>();

    return raw.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = Number(row.count);
      return acc;
    }, {});
  }
}
