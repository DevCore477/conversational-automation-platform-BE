import {
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  forwardRef,
  OnModuleInit,
} from '@nestjs/common';

import { CallRecordService } from './call-record.service';
import { InboundCallAdmissionService } from './inbound-call-admission.service';
import { CompaniesService } from '../../companies/companies.service';
import type { CallTranscriptTurn } from '../../models/calls/call-transcript.types';
import {
  CallState,
  CallStatus,
  ConversationMessage,
  CreateCallStateDto,
} from '../types/call-state.types';

/**
 * Valid forward transitions. Telnyx/Twilio events can arrive out of order or be redelivered
 * (duplicate webhook, a delayed `call.answered` landing after `call.hangup` already completed the
 * call), so `updateStatus` must not blindly overwrite a terminal state — otherwise a late event can
 * resurrect an already-ended call (flips it back to ACTIVE) or clobber a real FAILED with COMPLETED.
 * Terminal states (COMPLETED/FAILED/CANCELLED) have no outgoing transitions.
 */
const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<CallStatus, ReadonlySet<CallStatus>>> = {
  [CallStatus.INITIATING]: new Set([CallStatus.ACTIVE, CallStatus.FAILED, CallStatus.CANCELLED]),
  [CallStatus.ACTIVE]: new Set([CallStatus.COMPLETED, CallStatus.FAILED]),
  [CallStatus.COMPLETED]: new Set(),
  [CallStatus.FAILED]: new Set(),
  [CallStatus.CANCELLED]: new Set(),
};

@Injectable()
export class CallStateService implements OnModuleInit {
  private readonly logger = new Logger(CallStateService.name);
  private readonly callStates = new Map<string, CallState>();

  constructor(
    @Inject(forwardRef(() => CallRecordService))
    private readonly callRecordService: CallRecordService,
    private readonly companyService: CompaniesService,
    @Inject(forwardRef(() => InboundCallAdmissionService))
    private readonly inboundCallAdmission: InboundCallAdmissionService,
  ) {}

  onModuleInit(): void {
    // Fire-and-forget: never delay app startup / traffic readiness on this. A fresh process's
    // in-memory `callStates` map above is always empty, so any DB row still non-terminal at this
    // exact moment is guaranteed orphaned from a PREVIOUS process's life (crash, deploy, OOM) —
    // see markOrphanedActiveCallsFailed's own doc for why that's a safe, sound inference.
    this.callRecordService
      .markOrphanedActiveCallsFailed()
      .then(count => {
        if (count > 0) {
          this.logger.warn(
            `Reconciled ${String(count)} call(s) left non-terminal by a previous process — marked FAILED`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to reconcile orphaned call records on startup:', error);
      });
  }

  create(dto: CreateCallStateDto): CallState {
    const now = new Date();
    const callState: CallState = {
      callSid: dto.callSid,
      status: CallStatus.INITIATING,
      phoneNumberFrom: dto.phoneNumberFrom,
      phoneNumberTo: dto.phoneNumberTo,
      script: dto.script,
      model: dto.model,
      voiceId: dto.voiceId,
      conversationHistory: [
        {
          role: 'system',
          content: dto.script,
          timestamp: now,
        },
      ],
      metadata: dto.metadata,
      createdAt: now,
      updatedAt: now,
      companyId: dto.companyId,
    };

    this.callStates.set(dto.callSid, callState);
    this.logger.log(`Created call state for callSid: ${dto.callSid}`);

    // Save to database asynchronously (non-blocking)
    // Skip if this is a retry (record already exists and was updated)
    const isRetry = dto.metadata?.isRetry === true;
    if (!isRetry) {
      void this.callRecordService.create(callState).catch((error: unknown) => {
        this.logger.error(`Failed to save call record to database:`, error);
      });
      if (dto.companyId) {
        void this.companyService.incrementCallCount(dto.companyId);
      }
    } else {
      this.logger.log(`Skipping database record creation for retry call: ${dto.callSid}`);
    }

    return callState;
  }

  get(callSid: string): CallState {
    const callState = this.callStates.get(callSid);
    if (!callState) {
      throw new NotFoundException(`Call state not found for callSid: ${callSid}`);
    }
    return callState;
  }

  findOne(callSid: string): CallState | null {
    return this.callStates.get(callSid) ?? null;
  }

  getAll(companyId?: string): CallState[] {
    if (!companyId) {
      return Array.from(this.callStates.values());
    }
    return Array.from(this.callStates.values()).filter(
      callState => callState.companyId === companyId,
    );
  }

  updateStatus(callSid: string, status: CallStatus): CallState {
    const callState = this.get(callSid);

    if (callState.status === status) {
      return callState; // Idempotent no-op — duplicate/redelivered event reporting the same state.
    }

    if (!ALLOWED_STATUS_TRANSITIONS[callState.status].has(status)) {
      this.logger.warn(
        `Ignoring invalid call status transition for ${callSid}: ${callState.status} -> ${status} ` +
          `(likely an out-of-order or redelivered webhook event; keeping existing status)`,
      );
      return callState;
    }

    callState.status = status;
    callState.updatedAt = new Date();

    this.logger.log(`Updated call status for ${callSid}: ${status}`);

    // Update database record
    const completedAt =
      status === CallStatus.COMPLETED || status === CallStatus.FAILED ? new Date() : undefined;

    void this.callRecordService
      .updateStatus(callSid, status, completedAt)
      .catch((error: unknown) => {
        this.logger.error(`Failed to update call record in database:`, error);
      });

    // Release inbound admission capacity the instant an inbound call reaches a terminal state —
    // centralized here (rather than in every hangup/cleanup call site) so no path can forget to
    // free the slot. Outbound calls never held inbound capacity, so this is a no-op for them.
    if (
      (status === CallStatus.COMPLETED ||
        status === CallStatus.FAILED ||
        status === CallStatus.CANCELLED) &&
      callState.metadata?.callType === 'inbound'
    ) {
      void this.inboundCallAdmission.release(callSid);
    }

    return callState;
  }

  addMessage(callSid: string, message: ConversationMessage): CallState {
    const callState = this.get(callSid);

    const messageWithTimestamp = {
      ...message,
      timestamp: message.timestamp ?? new Date(),
    };

    callState.conversationHistory.push(messageWithTimestamp);
    callState.updatedAt = new Date();

    this.logger.debug(
      `Added ${message.role} message to call ${callSid}: ${message.content.substring(0, 50)}...`,
    );

    if (message.role === 'user' || message.role === 'assistant') {
      const turn: CallTranscriptTurn = {
        role: message.role === 'assistant' ? 'agent' : 'user',
        text: messageWithTimestamp.content,
        at: messageWithTimestamp.timestamp.toISOString(),
      };
      void this.callRecordService.appendConversationTurn(callSid, turn).catch((error: unknown) => {
        this.logger.error(`Failed to append transcript turn for ${callSid}:`, error);
      });
    }

    return callState;
  }

  updateMetadata(callSid: string, metadata: Record<string, unknown>): CallState {
    const callState = this.get(callSid);
    callState.metadata = {
      ...callState.metadata,
      ...metadata,
    };
    callState.updatedAt = new Date();

    void this.callRecordService.mergeMetadata(callSid, metadata).catch((error: unknown) => {
      this.logger.error(`Failed to merge call record metadata for ${callSid}:`, error);
    });

    return callState;
  }

  delete(callSid: string): void {
    const existed = this.callStates.delete(callSid);
    if (existed) {
      this.logger.log(`Deleted call state for callSid: ${callSid}`);
    }
  }

  exists(callSid: string): boolean {
    return this.callStates.has(callSid);
  }

  cleanupOldStates(maxAgeMinutes = 60): number {
    const now = new Date();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    let deletedCount = 0;

    for (const [callSid, callState] of this.callStates.entries()) {
      const ageMs = now.getTime() - callState.updatedAt.getTime();

      if (ageMs > maxAgeMs && callState.status !== CallStatus.ACTIVE) {
        this.callStates.delete(callSid);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${String(deletedCount)} old call states`);
    }

    return deletedCount;
  }

  getStats(companyId?: string, period?: 'hour' | 'day' | 'week' | 'month') {
    let states: CallState[];
    if (period) {
      const now = new Date();
      const periodMs = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = new Date(now.getTime() - (periodMs[period] || periodMs.day));
      states = Array.from(this.callStates.values()).filter(callState => {
        const matchesCompany = companyId ? callState.companyId === companyId : true;
        const isRecent = callState.createdAt >= cutoff;
        return matchesCompany && isRecent;
      });
    } else {
      states = companyId
        ? Array.from(this.callStates.values()).filter(s => s.companyId === companyId)
        : Array.from(this.callStates.values());
    }
    // if (companyId) {
    //   states = Array.from(this.callStates.values()).filter(callState => {
    //     return callState.companyId === companyId;
    //   });
    // } else {
    //   states = Array.from(this.callStates.values());
    // }
    return {
      total: states.length,
      byStatus: {
        initiating: states.filter(s => s.status === CallStatus.INITIATING).length,
        active: states.filter(s => s.status === CallStatus.ACTIVE).length,
        completed: states.filter(s => s.status === CallStatus.COMPLETED).length,
        failed: states.filter(
          s => s.status === CallStatus.FAILED || s.status === CallStatus.CANCELLED,
        ).length,
      },
    };
  }
}
