import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import {
  buildInteractiveReminderAgentScript,
  DRIVER_REMINDER_PLACEHOLDERS,
  renderDriverReminderScript,
} from './royal-transfer-script.util';
import { RoyalTransferClient } from './royal-transfer.client';
import { RoyalTransferPobBooking } from './royal-transfer.types';
import { CallsService } from '../../calls/calls.service';
import type { OutboundCallJobResult } from '../../calls/queue/call-queue.types';
import { OutboundCallQueueService } from '../../calls/queue/outbound-call-queue.service';
import type callQueueConfig from '../../configs/call-queue.config';
import { OpenAIModel } from '../../common/enums';
import { normalizePhoneNumber } from '../../common/utils/phone.util';

/** How much longer than the queue's own CALL_TIMEOUT_MS this job waits before giving up on one
 *  booking's outcome — must exceed it so the worker's own timeout always wins the race. */
const PER_BOOKING_WAIT_BUFFER_MS = 60_000;

/** Maps the outbound queue's outcome vocabulary to the driver-call-response API's vocabulary. */
function jobOutcomeToCallResult(
  outcome: OutboundCallJobResult['outcome'],
): 'answered' | 'missed' | 'busy' | 'failed' {
  switch (outcome) {
    case 'answered':
      return 'answered';
    case 'busy':
      return 'busy';
    case 'no_answer':
    case 'cancelled':
    case 'timeout':
      return 'missed';
    case 'failed':
    case 'dial_failed':
    default:
      return 'failed';
  }
}

/** Fallback template when config is not set (POB / non-cancelled). */
const FALLBACK_DRIVER_REMINDER_TEMPLATE = `Hi {{driverName}}, this is a quick reminder about your booking. Can you confirm that you are coming for the pickup and drop-off? You have a transfer from {{pickup}} to {{dropOff}} at {{time}} on {{date}}. Please confirm if you will be there.`;

/** Fallback template when config is not set (CANCELLED). */
const FALLBACK_DRIVER_REMINDER_TEMPLATE_CANCELLED = `Hi {{driverName}}, we are informing you that your booking has been cancelled. The cancelled booking was a transfer from {{pickup}} to {{dropOff}} scheduled for {{time}} on {{date}}. Thank you.`;

/** Default cron expression when config key is missing (every 2 hours). */
const DEFAULT_DRIVER_REMINDER_CRON = '0 */2 * * *';

/** First message: greeting + reminder + invite questions (interactive call). */
function buildFullReminderFirstMessage(renderedScript: string): string {
  return `Hello, I'm calling from Royal Transfer. ${renderedScript} Do you have any questions about the address, time, or anything else?`;
}

@Injectable()
export class RoyalTransferService implements OnModuleInit {
  private readonly logger = new Logger(RoyalTransferService.name);
  private isCronRunning = false;

  constructor(
    private readonly royalTransfer: RoyalTransferClient,
    private readonly config: ConfigService,
    private readonly callsService: CallsService,
    private readonly outboundCallQueue: OutboundCallQueueService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit() {
    const enabled = this.config.get<boolean>('royalTransfer.driverReminderCronEnabled');
    if (enabled === false) {
      this.logger.log('Driver reminder cron is disabled (DRIVER_REMINDER_CRON_ENABLED=false)');
      return;
    }
    const expression =
      this.config.get<string>('royalTransfer.driverReminderCronExpression') ??
      DEFAULT_DRIVER_REMINDER_CRON;
    const job = new CronJob(expression, () => {
      void this.runDriverRemindersCron();
    });
    this.schedulerRegistry.addCronJob('driver-reminders', job);
    job.start();
    this.logger.log(`Driver reminder cron registered: ${expression} (every 2 hours by default)`);
  }

  /**
   * Runs trigger-driver-reminders (same as POST /integrations/royal-transfer/trigger-driver-reminders).
   * Called by the cron job every 2 hours by default.
   */
  async runDriverRemindersCron() {
    if (this.isCronRunning) {
      this.logger.warn('Driver reminder cron skipped: previous run still in progress');
      return;
    }
    this.isCronRunning = true;
    try {
      this.logger.log('🕐 Driver reminder cron: starting trigger-driver-reminders');
      const result = await this.triggerDriverReminders(undefined);
      this.logger.log(
        `🕐 Driver reminder cron: finished — triggered ${result.triggered}, failed ${result.failed.length}`,
      );
    } catch (err) {
      this.logger.error('Driver reminder cron failed:', err instanceof Error ? err.message : err);
    } finally {
      this.isCronRunning = false;
    }
  }

  /** Returns the driver reminder script template for POB (and non-cancelled). Uses config when set. */
  getDriverReminderTemplate(): string {
    return (
      this.config.get<string>('royalTransfer.driverReminderScriptTemplate') ??
      FALLBACK_DRIVER_REMINDER_TEMPLATE
    );
  }

  /** Returns the driver reminder template for CANCELLED bookings. Uses config when set. */
  getDriverReminderTemplateCancelled(): string {
    return (
      this.config.get<string>('royalTransfer.driverReminderScriptTemplateCancelled') ??
      FALLBACK_DRIVER_REMINDER_TEMPLATE_CANCELLED
    );
  }

  /** Picks template by booking status: CANCELLED uses cancelled template, else POB template. */
  private getDriverReminderTemplateForBooking(booking: RoyalTransferPobBooking): string {
    return booking.status === 'CANCELLED'
      ? this.getDriverReminderTemplateCancelled()
      : this.getDriverReminderTemplate();
  }

  /** Renders the driver reminder script for a given booking using the template for its status. */
  renderDriverReminderForBooking(booking: RoyalTransferPobBooking): string {
    const template = this.getDriverReminderTemplateForBooking(booking);
    return renderDriverReminderScript(booking, template);
  }

  /** Fetches today's bookings and returns each with its rendered driver reminder script and normalized driver number. */
  async getTodayBookingsWithScripts(): Promise<
    {
      booking: RoyalTransferPobBooking;
      script: string;
      normalizedDriverNumber: string;
    }[]
  > {
    const bookings = await this.royalTransfer.getTodayPobBookings();
    return bookings.map(booking => ({
      booking,
      script: renderDriverReminderScript(
        booking,
        this.getDriverReminderTemplateForBooking(booking),
      ),
      normalizedDriverNumber: this.getNormalizedDriverNumber(booking),
    }));
  }

  /** Returns placeholder names for the driver reminder template (for docs/UI). */
  getDriverReminderPlaceholders(): readonly string[] {
    return DRIVER_REMINDER_PLACEHOLDERS;
  }

  /**
   * Cancels a booking by driver (from call). Call when the driver cancels during/from a call.
   * Uses PATCH /public/bookings/:id/cancel-by-driver on the Royal Transfer platform.
   */
  async cancelBookingByDriver(bookingId: string, reason?: string | null): Promise<boolean> {
    return this.royalTransfer.cancelBookingByDriver(bookingId, reason);
  }

  /**
   * Returns the driver number normalized for outbound calls (E.164).
   */
  getNormalizedDriverNumber(booking: RoyalTransferPobBooking): string {
    return normalizePhoneNumber(booking.driverNumber);
  }

  /**
   * Fetches today's bookings, finds the one with the given bookingId, and returns
   * the rendered driver reminder script and normalized driver number (for preview endpoints).
   */
  async getPreviewByBookingId(
    bookingId: string,
  ): Promise<
    | { script: string; booking: RoyalTransferPobBooking; normalizedDriverNumber: string }
    | { error: string }
  > {
    const bookings = await this.royalTransfer.getTodayPobBookings();
    const booking = bookings.find(b => b.bookingId === bookingId);
    if (!booking) {
      return { error: `Booking ${bookingId} not found in today's bookings` };
    }
    const script = this.renderDriverReminderForBooking(booking);
    const normalizedDriverNumber = this.getNormalizedDriverNumber(booking);
    return { script, booking, normalizedDriverNumber };
  }

  /**
   * Fetches today's POB bookings and calls every driver concurrently through the outbound call
   * queue (MAX_CONCURRENT_OUTBOUND_CALLS caps how many are actually ringing/active at once — the
   * queue itself distributes work across that budget, it does not serialize bookings). Each
   * booking is fully independent end-to-end: its own queue job, its own call session, its own
   * bookkeeping — one booking failing, timing out, or the driver being busy never delays or
   * affects any other booking's call.
   */
  async triggerDriverReminders(companyId?: string): Promise<{
    ok: boolean;
    triggered: number;
    failed: { bookingId: string; driverNumber: string; error: string }[];
    callSids: string[];
  }> {
    const bookings = await this.royalTransfer.getTodayPobBookings();

    const outcomes = await Promise.all(
      bookings.map((booking, index) =>
        this.processDriverReminderCall(booking, index, bookings.length, companyId),
      ),
    );

    const callSids = outcomes.flatMap(o => (o.callSid ? [o.callSid] : []));
    const failed = outcomes.flatMap(o => (o.failed ? [o.failed] : []));

    return {
      ok: true,
      triggered: callSids.length,
      failed,
      callSids,
    };
  }

  /** One booking's entire call lifecycle: enqueue -> dial -> wait for the call to end -> record
   *  the outcome on the Royal Transfer platform. Runs concurrently with every other booking's
   *  call, bounded only by the outbound queue's configured concurrency. */
  private async processDriverReminderCall(
    booking: RoyalTransferPobBooking,
    index: number,
    total: number,
    companyId: string | undefined,
  ): Promise<{
    callSid?: string;
    failed?: { bookingId: string; driverNumber: string; error: string };
  }> {
    const normalized = this.getNormalizedDriverNumber(booking);
    if (!normalized) {
      return {
        failed: {
          bookingId: booking.bookingId,
          driverNumber: booking.driverNumber ?? '',
          error: 'No valid driver number',
        },
      };
    }

    const template = this.getDriverReminderTemplateForBooking(booking);
    const renderedScript = renderDriverReminderScript(booking, template);
    const fullFirstMessage = buildFullReminderFirstMessage(renderedScript);
    const interactiveScript = buildInteractiveReminderAgentScript(booking, renderedScript);

    this.logger.log(
      `[${String(index + 1)}/${String(total)}] Booking ${booking.bookingId} — queuing interactive call to ${normalized}`,
    );

    const recordFailure = async (error: string) => {
      await this.royalTransfer
        .postDriverCallResponse(booking.bookingId, {
          callType: 'information',
          confirmed: false,
          callResult: 'failed',
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to record driver-call-response for booking ${booking.bookingId}:`,
            err,
          );
        });
      return {
        failed: { bookingId: booking.bookingId, driverNumber: normalized, error },
      };
    };

    let callQueueId: string;
    try {
      callQueueId = await this.outboundCallQueue.enqueue(
        {
          to: normalized,
          script: interactiveScript,
          model: OpenAIModel.GPT_4O_MINI,
          firstMessage: fullFirstMessage,
          bookingId: booking.bookingId,
        },
        companyId,
        undefined,
        'royal-transfer-driver-reminder',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Booking ${booking.bookingId} — failed to queue call: ${message}`);
      return recordFailure(message);
    }

    const cfg = this.config.get<ConfigType<typeof callQueueConfig>>('callQueue');
    const jobResult = await this.outboundCallQueue.waitForCompletion(
      callQueueId,
      (cfg?.callTimeoutMs ?? 10 * 60 * 1000) + PER_BOOKING_WAIT_BUFFER_MS,
    );

    if (!jobResult.callSid) {
      const message = jobResult.error ?? 'Call could not be dialed';
      this.logger.warn(`Booking ${booking.bookingId} — dial failed: ${message}`);
      return recordFailure(message);
    }

    const callSid = jobResult.callSid;
    this.logger.log(
      `[callId=${callSid}] Booking ${booking.bookingId} — call ended: ${jobResult.outcome}`,
    );

    const callResult = jobOutcomeToCallResult(jobResult.outcome);
    let driverCancelledReason: string | null | undefined;
    try {
      const callState = this.callsService.getCallState(callSid);
      driverCancelledReason = callState.metadata?.driverCancelledReason as
        | string
        | null
        | undefined;
    } catch {
      driverCancelledReason = undefined;
    }
    const confirmed = !driverCancelledReason && jobResult.outcome === 'answered';

    // Always record driver call response (public API) after each attempt — include reason when
    // driver cancelled. Never skip when user didn't pick up or canceled.
    await this.royalTransfer
      .postDriverCallResponse(booking.bookingId, {
        callType: 'information',
        confirmed,
        reason:
          driverCancelledReason != null && driverCancelledReason !== ''
            ? driverCancelledReason
            : undefined,
        callResult,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to record driver-call-response for booking ${booking.bookingId}:`,
          err,
        );
      });

    if (driverCancelledReason) {
      this.logger.log(
        `[callId=${callSid}] Booking ${booking.bookingId} — driver cancelled (reason: "${driverCancelledReason}"); driver-call-response sent with reason, not marking information call sent`,
      );
    } else if (confirmed) {
      this.logger.log(
        `[callId=${callSid}] Booking ${booking.bookingId} — call completed (user picked up and ended); marking information call sent`,
      );
      await this.royalTransfer
        .updateInformationCallSent(booking.bookingId, true)
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to mark information call sent for booking ${booking.bookingId}:`,
            err,
          );
        });
    } else {
      this.logger.log(
        `[callId=${callSid}] Booking ${booking.bookingId} — call ended with outcome "${jobResult.outcome}"; recorded ${callResult}`,
      );
    }

    return { callSid };
  }
}
