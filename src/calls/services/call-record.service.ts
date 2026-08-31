import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, MoreThanOrEqual } from 'typeorm';

import { CallRecord } from '../../models/calls/call-record.entity';
import type { CallTranscriptTurn } from '../../models/calls/call-transcript.types';
import { CallState } from '../types/call-state.types';

@Injectable()
export class CallRecordService {
  private readonly logger = new Logger(CallRecordService.name);

  constructor(
    @InjectRepository(CallRecord)
    private readonly callRecordRepository: Repository<CallRecord>,
  ) {}

  /**
   * Create a call record from call state
   */
  async create(callState: CallState): Promise<CallRecord> {
    try {
      // Set retry schedule for outbound calls (2 hours from now)
      const nextRetryAt: Date | undefined =
        callState.metadata?.callType === 'outbound'
          ? new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours
          : undefined;

      const meta = callState.metadata;
      const callType = this.determineCallType(callState);

      const record = this.callRecordRepository.create({
        callSid: callState.callSid,
        status: callState.status,
        phoneNumberFrom: callState.phoneNumberFrom,
        phoneNumberTo: callState.phoneNumberTo,
        script: callState.script,
        model: callState.model,
        provider: meta && typeof meta.provider === 'string' ? meta.provider : undefined,
        scriptId: meta && typeof meta.scriptId === 'string' ? meta.scriptId : undefined,
        scriptName: meta && typeof meta.scriptName === 'string' ? meta.scriptName : undefined,
        callType: callType ?? undefined,
        metadata: callState.metadata,
        createdAt: callState.createdAt,
        updatedAt: callState.updatedAt,
        retryAttempts: 0,
        maxRetryAttempts: 3,
        nextRetryAt,
        companyId: callState.companyId,
      });

      const saved = await this.callRecordRepository.save(record);
      this.logger.log(`Created call record for ${callState.callSid}`);

      return saved;
    } catch (error) {
      this.logger.error(`Failed to create call record:`, error);
      throw error;
    }
  }

  /**
   * Merge fields into the JSON metadata column (e.g. inbound AI summary after call ends).
   */
  /**
   * Replace the full conversation transcript (user + agent turns).
   * Called when a voice session ends so the DB reflects the full dialogue.
   */
  async setConversationTranscript(callSid: string, turns: CallTranscriptTurn[]): Promise<void> {
    try {
      const result = await this.callRecordRepository.update(
        { callSid },
        { conversationTranscript: turns, updatedAt: new Date() },
      );
      if (!result.affected) {
        this.logger.warn(`setConversationTranscript: no row for callSid=${callSid}`);
        return;
      }
      this.logger.log(
        `Saved conversation transcript for ${callSid} (${String(turns.length)} turn(s))`,
      );
    } catch (error) {
      this.logger.error(`setConversationTranscript failed for ${callSid}:`, error);
    }
  }

  /**
   * Append a single turn (incremental persistence for non-voice paths).
   */
  async appendConversationTurn(callSid: string, turn: CallTranscriptTurn): Promise<void> {
    try {
      const record = await this.callRecordRepository.findOne({ where: { callSid } });
      if (!record) {
        this.logger.warn(`appendConversationTurn: no record for ${callSid}`);
        return;
      }
      const prev = Array.isArray(record.conversationTranscript)
        ? record.conversationTranscript
        : [];
      record.conversationTranscript = [...prev, turn];
      record.updatedAt = new Date();
      await this.callRecordRepository.save(record);
    } catch (error) {
      this.logger.error(`appendConversationTurn failed for ${callSid}:`, error);
    }
  }

  async mergeMetadata(callSid: string, patch: Record<string, unknown>): Promise<void> {
    try {
      const record = await this.callRecordRepository.findOne({ where: { callSid } });
      if (!record) {
        this.logger.warn(`mergeMetadata: no record for ${callSid}`);
        return;
      }
      record.metadata = { ...record.metadata, ...patch };
      record.updatedAt = new Date();
      await this.callRecordRepository.save(record);
    } catch (error) {
      this.logger.error(`mergeMetadata failed for ${callSid}:`, error);
    }
  }

  /**
   * Update call record status and completion time
   */
  async updateStatus(
    callSid: string,
    status: string,
    completedAt?: Date,
  ): Promise<CallRecord | null> {
    try {
      const updatedAt = new Date();
      const patch: Pick<CallRecord, 'status' | 'updatedAt'> &
        Partial<Pick<CallRecord, 'completedAt' | 'duration'>> = {
        status,
        updatedAt,
      };

      if (completedAt) {
        const row = await this.callRecordRepository.findOne({
          where: { callSid },
          select: ['createdAt'],
        });
        if (!row) {
          this.logger.warn(`Call record not found for ${callSid}`);
          return null;
        }
        //Todo: properly calculate the call duration as it is not valid
        patch.completedAt = completedAt;
        patch.duration = Math.round((completedAt.getTime() - row.createdAt.getTime()) / 1000);
      }

      // Use UPDATE … SET only these columns so we never overwrite conversation_transcript / metadata
      // with a stale entity when status races with setConversationTranscript at hang-up.
      const result = await this.callRecordRepository.update({ callSid }, patch);

      if (!result.affected) {
        this.logger.warn(`Call record not found for ${callSid}`);
        return null;
      }

      this.logger.log(`Updated call record status for ${callSid}: ${status}`);
      return await this.callRecordRepository.findOne({ where: { callSid } });
    } catch (error) {
      this.logger.error(`Failed to update call record:`, error);
      return null;
    }
  }

  /**
   * Marks every call still in a non-terminal DB status ('initiating'/'active') as FAILED. Called
   * once at process startup: a fresh process's in-memory CallState map is always empty, so ANY
   * such row at that point is guaranteed to be orphaned from a previous process's life (crash,
   * deploy, OOM) — there is no live session anywhere that could still bring it to a real
   * COMPLETED/FAILED outcome, and without this it would sit in 'active' forever, e.g. permanently
   * (and wrongly) counting toward per-caller call-history views.
   *
   * Uses the existing `idx_call_records_status` index, so this stays cheap even on a large table.
   */
  async markOrphanedActiveCallsFailed(): Promise<number> {
    const orphaned = await this.callRecordRepository.find({
      where: { status: In(['initiating', 'active']) },
    });
    if (orphaned.length === 0) return 0;

    const now = new Date();
    for (const record of orphaned) {
      await this.callRecordRepository.update(
        { callSid: record.callSid },
        {
          status: 'failed',
          completedAt: now,
          updatedAt: now,
          metadata: {
            ...record.metadata,
            orphanedOnRestart: true,
            orphanedFromStatus: record.status,
            orphanedAt: now.toISOString(),
          },
        },
      );
    }
    return orphaned.length;
  }

  /**
   * Get all call records
   */
  async findOneByCallSid(callSid: string): Promise<CallRecord | null> {
    return this.callRecordRepository.findOne({ where: { callSid } });
  }

  async findAll(limit?: number, companyId?: string): Promise<CallRecord[]> {
    const queryBuilder = this.callRecordRepository
      .createQueryBuilder('call')
      .orderBy('call.createdAt', 'DESC');

    if (limit) {
      queryBuilder.limit(limit);
    }

    if (companyId) {
      queryBuilder.andWhere('call.companyId = :companyId', { companyId });
    }

    return queryBuilder.getMany();
  }

  /**
   * Calls created on or after `since` (for dashboard volume and resource mix without loading full history).
   */
  async findSince(since: Date, companyId?: string): Promise<CallRecord[]> {
    const queryBuilder = this.callRecordRepository
      .createQueryBuilder('call')
      .where('call.createdAt >= :since', { since })
      .orderBy('call.createdAt', 'DESC');

    if (companyId) {
      queryBuilder.andWhere('call.companyId = :companyId', { companyId });
    }

    return queryBuilder.getMany();
  }

  /**
   * Minimal rows for dashboard attribution (agent / flow / script from metadata and columns).
   * Optional date range filters on `createdAt` (inclusive `from`, inclusive `to`).
   */
  async findAttributionRows(
    companyId?: string,
    filter?: { from?: Date; to?: Date },
  ): Promise<CallRecord[]> {
    const queryBuilder = this.callRecordRepository
      .createQueryBuilder('call')
      .select([
        'call.status',
        'call.scriptId',
        'call.metadata',
        'call.companyId',
        'call.createdAt',
      ]);

    if (companyId) {
      queryBuilder.where('call.companyId = :companyId', { companyId });
    }

    if (filter?.from) {
      queryBuilder.andWhere('call.createdAt >= :from', { from: filter.from });
    }
    if (filter?.to) {
      queryBuilder.andWhere('call.createdAt <= :to', { to: filter.to });
    }

    return queryBuilder.getMany();
  }

  /**
   * Get call records by date range
   */
  async findByDateRange(startDate: Date, endDate: Date): Promise<CallRecord[]> {
    return this.callRecordRepository
      .createQueryBuilder('call')
      .where('call.createdAt BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      })
      .orderBy('call.createdAt', 'DESC')
      .getMany();
  }

  /**
   * Get call records by script ID
   */
  async findByScriptId(scriptId: string): Promise<CallRecord[]> {
    return this.callRecordRepository.find({
      where: { scriptId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get statistics
   */
  async getStats(
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<{
    total: number;
    byStatus: Record<string, number>;
    byCallType: Record<string, number>;
    last24Hours: number;
    lastHour: number;
  }> {
    const now = new Date();
    const last24HoursTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lastHourTime = new Date(now.getTime() - 60 * 60 * 1000);

    // Calculate period cutoff
    let periodStart: Date | undefined;
    if (period) {
      const msMap = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      periodStart = new Date(now.getTime() - msMap[period]);
    }

    // Build where clause
    const where: Record<string, unknown> = {};
    if (companyId) {
      where.companyId = companyId;
    }
    if (periodStart) {
      where.createdAt = MoreThanOrEqual(periodStart);
    }

    const all = await this.callRecordRepository.find({ where });

    const byStatus: Record<string, number> = {};
    const byCallType: Record<string, number> = {};
    let last24Hours = 0;
    let lastHour = 0;

    for (const record of all) {
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;

      if (record.callType) {
        byCallType[record.callType] = (byCallType[record.callType] ?? 0) + 1;
      }

      if (record.createdAt >= last24HoursTime) {
        last24Hours++;
      }
      if (record.createdAt >= lastHourTime) {
        lastHour++;
      }
    }

    return {
      total: all.length,
      byStatus,
      byCallType,
      last24Hours,
      lastHour,
    };
  }

  /**
   * Determine call type from call state
   */
  private determineCallType(callState: CallState): string | null {
    const ct = callState.metadata?.callType;
    if (typeof ct === 'string') {
      return ct;
    }

    // Infer from phone numbers or other metadata
    // This is a simple heuristic - adjust based on your needs
    return null;
  }

  /**
   * Clean up old records (optional - keep for X days)
   */
  async cleanupOldRecords(daysToKeep = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.callRecordRepository
      .createQueryBuilder()
      .delete()
      .where('createdAt < :cutoffDate', { cutoffDate })
      .execute();

    const affected = result.affected ?? 0;
    this.logger.log(
      `Cleaned up ${String(affected)} call records older than ${String(daysToKeep)} days`,
    );

    return affected;
  }
}
