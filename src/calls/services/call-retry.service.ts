import { Injectable, Logger } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, In, Not, IsNull, Repository } from 'typeorm';

import { TelnyxClient } from '../../clients/telnyx/telnyx.client';
import { TwilioClient } from '../../clients/twilio/twilio.client';
import type callQueueConfig from '../../configs/call-queue.config';
import { CallRecord } from '../../models/calls/call-record.entity';
import { runWithConcurrency } from '../../common/utils/concurrency-limiter.util';
import { toTelnyxCallSid } from '../utils/telnyx-call-sid.util';
import { CallStateService } from './call-state.service';

interface RetryHistoryEntry {
  attemptNumber: number;
  oldCallSid: string;
  newCallSid: string;
  retriedAt: string;
}

function readRetryHistory(
  metadata: Record<string, unknown> | null | undefined,
): RetryHistoryEntry[] {
  const raw = metadata?.retryHistory;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw as RetryHistoryEntry[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Match outbound Telnyx rows (TLX_* SID, metadata, or provider column). */
function usesTelnyxTelephony(record: CallRecord): boolean {
  if (record.callSid.startsWith('TLX_')) {
    return true;
  }
  const meta = record.metadata;
  if (meta && typeof meta.telephonyProvider === 'string' && meta.telephonyProvider === 'telnyx') {
    return true;
  }
  const p = record.provider;
  return p != null && p.startsWith('telnyx');
}

@Injectable()
export class CallRetryService {
  private readonly logger = new Logger(CallRetryService.name);
  private isProcessing = false;

  constructor(
    @InjectRepository(CallRecord)
    private readonly callRecordRepository: Repository<CallRecord>,
    private readonly twilioClient: TwilioClient,
    private readonly telnyxClient: TelnyxClient,
    private readonly configService: ConfigService,
    private readonly callStateService: CallStateService,
  ) {}

  /**
   * Cron job that runs every 30 minutes to check for calls that need retry
   */
  @Cron(CronExpression.EVERY_2_HOURS, {
    name: 'call-retry-check',
  })
  async handleCallRetries() {
    const currentDate = new Date();

    // Check if today is a business day (Monday to Friday)
    const isBusinessDay = currentDate.getDay() >= 1 && currentDate.getDay() <= 5; // Monday = 1, Friday = 5

    // Check if current time is within business hours (9 AM to 5 PM)
    const isBusinessHours = currentDate.getHours() >= 9 && currentDate.getHours() < 17; // 9 AM to 5 PM

    // Skip the job if it's outside business hours or not a business day
    if (!isBusinessDay || !isBusinessHours) {
      this.logger.log(`Skipping call retry job. It's either a weekend or outside business hours.`);
      return;
    }
    if (this.isProcessing) {
      this.logger.warn('Previous retry job still running, skipping this execution');
      return;
    }

    this.isProcessing = true;

    try {
      this.logger.log('🔄 Starting call retry check...');

      const callsToRetry = await this.getCallsEligibleForRetry();

      if (callsToRetry.length === 0) {
        this.logger.log('No calls found that need retry');
        return;
      }

      this.logger.log(`Found ${String(callsToRetry.length)} call(s) eligible for retry`);

      // Each retry is fully independent (own CallRecord row, own dial, own outcome) — bound
      // concurrency to the same MAX_CONCURRENT_OUTBOUND_CALLS budget ad-hoc and campaign calls
      // respect instead of serializing retries one at a time with a fixed delay between them.
      const cfg = this.configService.get<ConfigType<typeof callQueueConfig>>('callQueue');
      const concurrency = cfg?.maxConcurrentOutboundCalls ?? 10;
      await runWithConcurrency(callsToRetry, concurrency, call =>
        this.retryCall(call).catch((err: unknown) => {
          this.logger.warn(
            `[callId=${call.callSid}] Retry failed independently of other retries: ${errMsg(err)}`,
          );
        }),
      );

      this.logger.log('✅ Call retry check completed');
    } catch (error) {
      this.logger.error('❌ Error in call retry job:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get calls that are eligible for retry.
   * Only retries OUTBOUND calls — inbound calls that fail (e.g. stream error) must NOT be
   * called back, as the system would be dialling the original caller uninvited which looks
   * like spam to Pakistani/international carriers and triggers 486 blocks.
   * Permanently-failed calls (486 busy, 404 not-found, 403 forbidden) are also excluded
   * because no amount of retrying will succeed when the carrier rejects the number outright.
   */
  private async getCallsEligibleForRetry(): Promise<CallRecord[]> {
    const calls = await this.callRecordRepository.find({
      where: [
        {
          // 'initiating' = call was never answered; 'failed' = call ended with an error.
          // Do NOT include 'active' — an active call needs no retry.
          status: In(['initiating', 'failed']),
          retryAttempts: LessThanOrEqual(2),
        },
      ],
      order: {
        phoneNumberTo: 'ASC',
        createdAt: 'DESC',
      },
      take: 50,
    });

    const mostRecentCalls = new Map<string, CallRecord>();
    for (const call of calls) {
      if (!mostRecentCalls.has(call.phoneNumberTo)) {
        mostRecentCalls.set(call.phoneNumberTo, call);
      }
    }

    return Array.from(mostRecentCalls.values()).filter(call => {
      const meta = call.metadata as Record<string, unknown> | null | undefined;

      // Skip inbound calls (the caller called us — we must not call them back).
      if (meta?.telnyxIsInbound === true) {
        this.logger.debug(
          `Skipping retry for ${call.callSid}: inbound call (would dial back the caller uninvited)`,
        );
        return false;
      }

      // Skip permanent carrier rejections — retrying will never succeed.
      const sipCause = String(meta?.telnyxSipHangupCause ?? '');
      const permanentFailures = new Set(['403', '404', '486', '487', '603']);
      if (sipCause && permanentFailures.has(sipCause)) {
        this.logger.debug(
          `Skipping retry for ${call.callSid}: permanent carrier rejection (SIP ${sipCause})`,
        );
        return false;
      }

      return true;
    });
  }

  /**
   * Retry a specific call
   */
  async retryCall(callRecord: CallRecord): Promise<void> {
    const voiceMode = this.configService.get<string>('voice.mode');
    if (voiceMode === 'local' || callRecord.callSid.startsWith('CA_LOCAL')) {
      this.logger.debug(`Skipping telephony retry for ${callRecord.callSid}: VOICE_MODE=local`);
      return;
    }

    try {
      this.logger.log(
        `Retrying call ${callRecord.callSid} (Attempt ${String(callRecord.retryAttempts + 1)}/${String(callRecord.maxRetryAttempts)})`,
      );

      // Update retry tracking
      callRecord.retryAttempts += 1;
      callRecord.lastRetryAt = new Date();

      // Check if we've reached max attempts
      if (callRecord.retryAttempts >= callRecord.maxRetryAttempts) {
        callRecord.status = 'failed';
        callRecord.nextRetryAt = null;

        await this.callRecordRepository.save(callRecord);

        this.logger.warn(
          `Call ${callRecord.callSid} failed after ${String(callRecord.maxRetryAttempts)} failed attempts`,
        );
        return;
      }

      // Attempt to make the call (Twilio vs Telnyx — same routing as original outbound dial)
      const baseUrl = this.configService.getOrThrow<string>('webhook.baseUrl');
      const voiceAgentWebhook = `${baseUrl}/webhook/voice-agent`;
      const telnyxWebhook = `${baseUrl}/webhook/telnyx/events`;
      const dialTelnyx = usesTelnyxTelephony(callRecord);

      try {
        let newCallSid: string;
        const meta = { ...callRecord.metadata };

        if (dialTelnyx) {
          if (!this.telnyxClient.isConfigured()) {
            throw new Error(
              'Telnyx is not configured (TELNYX_API_KEY / TELNYX_CONNECTION_ID); cannot retry a Telnyx call',
            );
          }
          const callControlId = await this.telnyxClient.call(
            callRecord.phoneNumberTo,
            callRecord.phoneNumberFrom,
            telnyxWebhook,
          );
          newCallSid = toTelnyxCallSid(callControlId);
          meta.telnyxCallControlId = callControlId;
          meta.telephonyProvider = 'telnyx';
          meta.telnyxBidirectionalCodec = 'L16';
          meta.telnyxInboundSampleRate = 16000;
          this.logger.log(
            `✅ Successfully initiated Telnyx retry. New call SID: ${newCallSid} (call_control_id=${callControlId})`,
          );
        } else {
          newCallSid = await this.twilioClient.call(
            callRecord.phoneNumberTo,
            callRecord.phoneNumberFrom,
            voiceAgentWebhook,
          );
          delete meta.telnyxCallControlId;
          meta.telephonyProvider = 'twilio';
          this.logger.log(`✅ Successfully initiated Twilio retry. New CallSid: ${newCallSid}`);
        }

        meta.provider = dialTelnyx
          ? (callRecord.provider ?? 'telnyx+elevenlabs')
          : (callRecord.provider ?? 'twilio+elevenlabs');

        // Store original callSid in metadata before updating
        const originalCallSid = callRecord.callSid;
        const retryHistory = [...readRetryHistory(meta)];

        retryHistory.push({
          attemptNumber: callRecord.retryAttempts,
          oldCallSid: originalCallSid,
          newCallSid,
          retriedAt: new Date().toISOString(),
        });

        // Create call state in memory with NEW callSid
        const callStateMetadata: Record<string, unknown> = {
          ...meta,
          isRetry: true,
          originalCallSid: retryHistory[0]?.oldCallSid ?? originalCallSid,
          retryAttempt: callRecord.retryAttempts,
          retryHistory,
          scriptId: callRecord.scriptId,
          scriptName: callRecord.scriptName,
          callType: callRecord.callType,
        };

        this.callStateService.create({
          callSid: newCallSid,
          phoneNumberFrom: callRecord.phoneNumberFrom,
          phoneNumberTo: callRecord.phoneNumberTo,
          script: callRecord.script,
          model: callRecord.model,
          provider: dialTelnyx
            ? (callRecord.provider ?? 'telnyx+elevenlabs')
            : (callRecord.provider ?? 'twilio+elevenlabs'),
          status: 'connecting',
          metadata: callStateMetadata,
        });

        this.logger.log(`✅ Created call state for retry CallSid: ${newCallSid}`);

        // Update existing record with new CallSid and metadata
        callRecord.callSid = newCallSid; // Update to new CallSid / Telnyx TLX_* SID
        callRecord.status = 'initiating';
        callRecord.nextRetryAt = null;
        callRecord.metadata = {
          ...meta,
          retryHistory,
          originalCallSid: retryHistory[0]?.oldCallSid ?? originalCallSid,
        };

        await this.callRecordRepository.save(callRecord);

        this.logger.log(
          `✅ Updated call record ${originalCallSid} -> ${newCallSid} (Attempt ${String(callRecord.retryAttempts)})`,
        );
      } catch (dialError) {
        this.logger.error(`Failed to retry call ${callRecord.callSid}:`, dialError);

        // Schedule next retry (2 hours from now)
        if (callRecord.retryAttempts < callRecord.maxRetryAttempts) {
          const nextRetry = new Date();
          nextRetry.setHours(nextRetry.getHours() + 2);
          callRecord.nextRetryAt = nextRetry;
          callRecord.status = 'failed';
        } else {
          callRecord.status = 'cancelled';
          callRecord.nextRetryAt = null;
        }

        await this.callRecordRepository.save(callRecord);
      }
    } catch (error) {
      this.logger.error(`Error processing retry for ${callRecord.callSid}:`, error);
    }
  }

  /**
   * Manually schedule a call for retry
   */
  async scheduleCallForRetry(callSid: string, retryAfterHours = 2): Promise<CallRecord> {
    const callRecord = await this.callRecordRepository.findOne({
      where: { callSid },
    });

    if (!callRecord) {
      throw new Error(`Call record not found: ${callSid}`);
    }

    if (callRecord.retryAttempts >= callRecord.maxRetryAttempts) {
      throw new Error(
        `Call has already reached maximum retry attempts (${String(callRecord.maxRetryAttempts)})`,
      );
    }

    const nextRetry = new Date();
    nextRetry.setHours(nextRetry.getHours() + retryAfterHours);

    callRecord.nextRetryAt = nextRetry;
    callRecord.status = 'failed';

    const updated = await this.callRecordRepository.save(callRecord);

    this.logger.log(`Scheduled call ${callSid} for retry at ${nextRetry.toISOString()}`);

    return updated;
  }

  /**
   * Cancel pending retries for a call
   */
  async cancelRetry(callSid: string): Promise<CallRecord> {
    const callRecord = await this.callRecordRepository.findOne({
      where: { callSid },
    });

    if (!callRecord) {
      throw new Error(`Call record not found: ${callSid}`);
    }

    callRecord.nextRetryAt = null;
    callRecord.status = 'cancelled';

    const updated = await this.callRecordRepository.save(callRecord);

    this.logger.log(`Cancelled retry for call ${callSid}`);

    return updated;
  }

  /**
   * Get retry statistics
   */
  async getRetryStats(): Promise<{
    pendingRetries: number;
    retriedToday: number;
    cancelledToday: number;
    successRate: number;
  }> {
    const now = new Date();
    const _todayStart = new Date(now);
    _todayStart.setHours(0, 0, 0, 0);

    const pendingRetries = await this.callRecordRepository.count({
      where: {
        nextRetryAt: Not(IsNull()),
        status: In(['initiating', 'failed']),
      },
    });

    const retriedToday = await this.callRecordRepository.count({
      where: {
        lastRetryAt: LessThanOrEqual(now),
        status: 'retried',
        updatedAt: LessThanOrEqual(now),
      },
    });

    const cancelledToday = await this.callRecordRepository.count({
      where: {
        status: 'cancelled',
        updatedAt: LessThanOrEqual(now),
      },
    });

    const totalRetriesRow = await this.callRecordRepository
      .createQueryBuilder('call')
      .select('SUM(call.retryAttempts)', 'total')
      .where('call.retryAttempts > 0')
      .getRawOne<{ total: string | null }>();

    const successfulRetries = await this.callRecordRepository.count({
      where: {
        status: 'completed',
        retryAttempts: LessThanOrEqual(0),
      },
    });

    const totalRetrySum = Number(totalRetriesRow?.total ?? 0);
    const successRate = totalRetrySum > 0 ? (successfulRetries / totalRetrySum) * 100 : 0;

    return {
      pendingRetries,
      retriedToday,
      cancelledToday,
      successRate: Math.round(successRate * 100) / 100,
    };
  }
}
