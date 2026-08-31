import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
  Query,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { TwilioWebhookDto } from './dto/twilio-webhook.dto';
import { InboundScriptResolverService } from './services/inbound-script-resolver.service';
import { TelnyxEventDedupService } from './services/telnyx-event-dedup.service';
import { WebhookService } from './webhook.service';
import { CallStatus } from '../calls/types/call-state.types';
import { CallStateService } from '../calls/services/call-state.service';
import { ConversationService } from '../calls/services/conversation.service';
import { InboundCallAdmissionService } from '../calls/services/inbound-call-admission.service';
import { TelnyxClient } from '../clients/telnyx/telnyx.client';
import {
  isTelnyxInboundInitiated,
  getTelnyxWebhookRawBody,
  verifyTelnyxWebhookSignature,
  type RequestWithRawBody,
} from '../clients/telnyx/telnyx-webhook.util';
import { KeyedAsyncLock } from '../common/utils/keyed-async-lock.service';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly conversationService: ConversationService,
    private readonly callStateService: CallStateService,
    private readonly inboundCallAdmission: InboundCallAdmissionService,
    private readonly inboundScriptResolver: InboundScriptResolverService,
    private readonly configService: ConfigService,
    private readonly telnyxClient: TelnyxClient,
    private readonly telnyxEventDedup: TelnyxEventDedupService,
    private readonly telnyxCallLock: KeyedAsyncLock,
  ) {}

  private localVoiceHangupTwiml(): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
  }

  private isLocalVoiceMode(): boolean {
    return this.configService.get<string>('voice.mode') === 'local';
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private parseTelnyxPayload(raw: unknown): {
    eventId?: string;
    eventType?: string;
    callControlId?: string;
    callLegId?: string;
    callSessionId?: string;
    direction?: string;
    state?: string;
    from?: string;
    to?: string;
    hangupCause?: string;
    sipHangupCause?: string;
  } {
    if (!WebhookController.isRecord(raw)) {
      return {};
    }
    const data = WebhookController.isRecord(raw.data) ? raw.data : {};
    const payload = WebhookController.isRecord(data.payload)
      ? data.payload
      : WebhookController.isRecord(raw.payload)
        ? raw.payload
        : {};

    const eventId = data.id ?? raw.id;
    const eventType = data.event_type ?? raw.event_type;
    const callControlId = payload.call_control_id ?? payload.call_leg_id;
    const callLegId = payload.call_leg_id;
    const callSessionId = payload.call_session_id;
    const direction = payload.direction;
    const state = payload.state;
    const from = payload.from ?? payload.from_number;
    const to = payload.to ?? payload.to_number;
    const hangupCause = payload.hangup_cause;
    const sipHangupCause = payload.sip_hangup_cause;

    return {
      eventId: typeof eventId === 'string' ? eventId : undefined,
      eventType: typeof eventType === 'string' ? eventType : undefined,
      callControlId: typeof callControlId === 'string' ? callControlId : undefined,
      callLegId: typeof callLegId === 'string' ? callLegId : undefined,
      callSessionId: typeof callSessionId === 'string' ? callSessionId : undefined,
      direction: typeof direction === 'string' ? direction : undefined,
      state: typeof state === 'string' ? state : undefined,
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      hangupCause: typeof hangupCause === 'string' ? hangupCause : undefined,
      sipHangupCause: typeof sipHangupCause === 'string' ? sipHangupCause : undefined,
    };
  }

  @Post()
  handleWebhook(
    @Body() dto: TwilioWebhookDto,
    @Query('callSid') callSid: string,
    @Res() res: Response,
  ): Response {
    this.webhookService.logWebhookEvent(dto);
    const effectiveCallSid = callSid || dto.CallSid;
    const twiml = effectiveCallSid
      ? this.webhookService.generateGatherTwiml(
          effectiveCallSid,
          'Hello! How can I help you today?',
        )
      : this.webhookService.generateTwiml();
    return res.type('text/xml').send(twiml);
  }

  /**
   * Twilio fetches this URL when redirecting an in-progress call to support (see TwilioClient.redirectCallToUrl).
   * Configure nothing on Twilio manually — the voice bridge issues a Calls API update with this URL.
   */
  @Post('twilio/transfer-support')
  handleTwilioTransferSupport(@Body() dto: TwilioWebhookDto, @Res() res: Response): Response {
    if (this.isLocalVoiceMode()) {
      return res.type('text/xml').send(this.localVoiceHangupTwiml());
    }
    const support = this.configService.get<string>('app.supportTransferPhoneNumber')?.trim() ?? '';
    if (!support) {
      this.logger.warn(
        'transfer-support TwiML requested but SUPPORT_TRANSFER_PHONE_NUMBER is unset',
      );
      return res.type('text/xml').send(this.localVoiceHangupTwiml());
    }
    const callerId =
      this.configService.get<string>('app.twilioPhoneNumber')?.trim() ?? dto.To ?? '';
    const twiml = this.webhookService.generateDialSupportTwiml(support, callerId || support);
    this.logger.log(`📞 Twilio transfer-support TwiML for CallSid=${dto.CallSid}`);
    return res.type('text/xml').send(twiml);
  }

  @Post('voice-agent')
  handleVoiceAgentWebhook(@Body() dto: TwilioWebhookDto, @Res() res: Response): Response {
    if (this.isLocalVoiceMode()) {
      this.logger.log(
        `📞 Voice agent webhook ignored (VOICE_MODE=local) — CallSid: ${dto.CallSid}`,
      );
      return res.type('text/xml').send(this.localVoiceHangupTwiml());
    }

    this.logger.log(`📞 Voice agent webhook - CallSid: ${dto.CallSid}, Status: ${dto.CallStatus}`);
    this.webhookService.logWebhookEvent(dto);

    const existingState = this.callStateService.findOne(dto.CallSid);
    if (!existingState) {
      this.logger.warn(
        `CallState not found for ${dto.CallSid} (expected when created by makeCall())`,
      );
    } else {
      this.logger.log(`CallState exists for ${dto.CallSid}, ready for streaming`);
    }

    const twiml = this.webhookService.generateVoiceAgentTwiml();
    return res.type('text/xml').send(twiml);
  }

  /**
   * Inbound call handler. Configure Twilio voice webhook to: POST /webhook/inbound
   */
  @Post('inbound')
  async handleInboundCall(@Body() dto: TwilioWebhookDto, @Res() res: Response): Promise<Response> {
    this.logger.log(`📞 Inbound - From: ${dto.From}, To: ${dto.To}, CallSid: ${dto.CallSid}`);
    this.webhookService.logWebhookEvent(dto);

    if (this.isLocalVoiceMode()) {
      this.logger.log(`📞 Inbound webhook skipped — local voice mode (no Twilio pipeline)`);
      return res.type('text/xml').send(this.localVoiceHangupTwiml());
    }

    const admission = await this.inboundCallAdmission.tryAdmit(dto.CallSid);
    if (!admission.admitted) {
      this.logger.warn(
        `[callId=${dto.CallSid}] Rejecting inbound Twilio call — ${admission.reason ?? 'at capacity'}`,
      );
      return res.type('text/xml').send(this.webhookService.generateRejectTwiml());
    }

    try {
      const resolved = await this.inboundScriptResolver.resolve(dto.From ?? '', dto.To ?? '');
      const metadata = this.inboundScriptResolver.toCallStateMetadata(resolved);
      metadata.provider = 'twilio+elevenlabs';
      metadata.telephonyProvider = 'twilio';

      this.callStateService.create({
        callSid: dto.CallSid,
        phoneNumberFrom: dto.From ?? '',
        phoneNumberTo: dto.To ?? '',
        script: resolved.script,
        model: resolved.model,
        voiceId: resolved.voiceId,
        provider: 'twilio+elevenlabs',
        status: 'connecting',
        metadata,
        companyId: resolved.companyId,
      });

      this.logger.log(`Created call state for inbound: ${dto.CallSid}`);
      const twiml = this.webhookService.generateVoiceAgentTwiml();
      return res.type('text/xml').send(twiml);
    } catch (error) {
      this.logger.error(`Error handling inbound ${dto.CallSid}:`, error);
      // No CallState was created (or the flow errored before it could reach a terminal status),
      // so the centralized release-on-terminal-status path in CallStateService never fires here —
      // release explicitly so this admitted slot doesn't leak.
      void this.inboundCallAdmission.release(dto.CallSid);
      const fallbackTwiml = this.webhookService.generateTwiml(
        "We're sorry, but we're experiencing technical difficulties. Please try again later.",
      );
      return res.type('text/xml').send(fallbackTwiml);
    }
  }

  /**
   * Shared "call is answered, attach media" pipeline — the single implementation used by both
   * directions: outbound reaches it only via the real `call.answered` webhook (the callee decides
   * when to pick up, so there's no earlier point we could act from); inbound reaches it both via
   * the webhook AND proactively right after our own `answer()` command succeeds (see the
   * `call.initiated` handler above), since a lost/delayed webhook must never be the only path to
   * starting media on a call we already know Telnyx accepted. Must always be called from within
   * `telnyxCallLock.run(callSid, ...)` — relies on that to serialize a proactive invocation against
   * a same-moment real webhook delivery for the same call.
   */
  /** Returns whether media actually attached — callers that can retry later (the reconciliation
   * poller) need this to tell "succeeded" apart from "failed, don't bother trying again". */
  private async handleCallAnswered(
    callSid: string,
    callControlId: string,
    trigger: string,
  ): Promise<boolean> {
    const answeredAt = Date.now();
    const wsUrl = this.webhookService.getVoiceStreamWsUrl();
    const callState = this.callStateService.findOne(callSid);
    const sinceInitiatedMs = callState ? answeredAt - callState.createdAt.getTime() : undefined;
    this.logger.log(
      `📶 Handling call-answered for ${callSid} (trigger: ${trigger}) — starting media attach ` +
        `(since call initiated: ${sinceInitiatedMs != null ? `${String(sinceInitiatedMs)}ms` : 'n/a'}, ` +
        `current status: ${callState?.status ?? 'no call state'}, stream target url: ${wsUrl})`,
    );

    if (!callState) {
      this.logger.warn(
        `⚠️ handleCallAnswered for ${callSid} (trigger: ${trigger}) found no call state — ` +
          `cannot attach media (next expected event: call.hangup)`,
      );
      return false;
    }

    // The call is genuinely connected the instant it's answered — mark ACTIVE immediately,
    // independent of whether the media-stream attach below succeeds. Gating this on stream
    // success used to leave the status stuck at INITIATING when streaming_start failed, so a
    // later normal hangup misread that as "never answered" and mis-reported a real, answered
    // call as a false FAILED/busy.
    if (callState.status !== CallStatus.ACTIVE) {
      this.callStateService.updateStatus(callSid, CallStatus.ACTIVE);
    }

    const alreadyStreaming = callState.metadata?.telnyxStreamStarted === true;
    if (alreadyStreaming) {
      this.logger.log(
        `🔄 handleCallAnswered for ${callSid} (trigger: ${trigger}) — stream already active, skipping ` +
          `(this is the expected, harmless outcome when both the proactive path and the real webhook fire)`,
      );
      return true;
    }

    // The caller is live on the line from this point — every millisecond here is dead air. Telnyx
    // allows exactly one bidirectional RTP stream per call — issuing a *second* streaming_start
    // with a *different* target_legs after the first attempt is a documented way to conflict with
    // that limit if the first attempt partially took effect despite reporting failure. So this
    // never switches targets mid-call: 'both' (proven reliable for both inbound and outbound calls
    // in this project) is tried, and on failure retried once more with the *same* configuration —
    // which is always safe, since a repeat of an identical streaming_start is idempotent (Telnyx
    // reports "already streaming" for a redundant one, which TelnyxClient already treats as
    // success) — rather than escalating to a different, possibly-conflicting stream configuration.
    const target = 'both' as const;
    const maxAttempts = 2;

    let started = false;
    let lastErr: unknown;
    let notAnsweredYet = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        await this.telnyxClient.startBidirectionalStream(callControlId, wsUrl, target);
        this.logger.log(
          `🎙️ Bidirectional stream started (${target}, attempt ${String(attempt)}/${String(maxAttempts)}) for ${callSid} in ${String(Date.now() - attemptStartedAt)}ms ` +
            `(total time since answer: ${String(Date.now() - answeredAt)}ms, trigger: ${trigger})`,
        );
        started = true;
        break;
      } catch (err) {
        lastErr = err;
        // Telnyx's call-control state hasn't caught up to "answered" yet — seen when the
        // reconciliation poller's `is_alive` check fires slightly ahead of Telnyx's own internal
        // state transition. This is not a real failure, just early; retrying the *same* request
        // a couple seconds from now (via the reconciliation poller) will succeed once the state
        // settles. No point burning the second attempt on the same premature timing, and no point
        // logging it as an alarming failure — fail fast and let the caller decide whether to retry.
        if (/not answered yet|90034/i.test(errMsg(err))) {
          notAnsweredYet = true;
          this.logger.debug(
            `Call ${callSid} not answered yet per Telnyx call-control state (attempt ${String(attempt)}/${String(maxAttempts)}) — will retry later rather than immediately`,
          );
          break;
        }
        this.logger.warn(
          `⚠️ Stream start (${target}, attempt ${String(attempt)}/${String(maxAttempts)}) failed for ${callSid} after ${String(Date.now() - attemptStartedAt)}ms: ${errMsg(err)}`,
        );
        // The call itself is already gone (hung up / torn down) — retrying would just fail
        // identically. Stop immediately instead of burning more dead-air budget on a dead call.
        if (/no longer active|can'?t receive commands/i.test(errMsg(err))) {
          this.logger.warn(`Call ${callSid} is no longer active — aborting stream-start retries`);
          break;
        }
      }
    }

    if (this.callStateService.exists(callSid)) {
      this.callStateService.updateMetadata(callSid, {
        telnyxStreamStarted: started,
        ...(started ? {} : { telnyxStreamStartError: errMsg(lastErr) }),
      });
    }

    if (!started && !notAnsweredYet) {
      // The call is still up (SIP-wise) but has no AI audio path — a real, distinct failure from
      // "never answered". Surface it loudly instead of failing the whole webhook: the call's
      // status correctly stays ACTIVE/COMPLETED based on what actually happened on the wire, not
      // on our own media-attach bug.
      this.logger.error(
        `❌ Failed to start bidirectional stream for ${callSid} after ${String(maxAttempts)} attempts (${String(Date.now() - answeredAt)}ms total, trigger: ${trigger}) — ` +
          `call is connected but has no AI audio (next expected event: call.hangup)`,
        lastErr,
      );
    }

    return started;
  }

  /**
   * Background safety net for outbound calls. Started right after `call.initiated` (direction
   * outgoing); does not block the webhook response — the caller must not `await` this.
   *
   * The callee answering is only known to us via the `call.answered` webhook, which is
   * at-least-once, not guaranteed, delivery. Observed in production: an outbound call where the
   * callee genuinely answered and stayed on the line for ~40 seconds hearing nothing, then hung
   * up — `call.answered` never arrived at all, while `call.initiated` and `call.hangup` for the
   * *same call* were delivered fine (the latter needed 5 delivery attempts). A lost webhook must
   * not be able to strand a live, answered call in permanent silence.
   *
   * Polls Telnyx's own call status (`GET /calls/{id}`, via `getCallStatus`) on a bounded schedule;
   * if Telnyx reports the leg alive before the real webhook shows up, this proactively runs the
   * exact same `handleCallAnswered` pipeline the webhook would have. Every tick re-checks whether
   * the real webhook already won the race, and every action that actually touches call state goes
   * through `telnyxCallLock`, so this can never duplicate or race a live webhook delivery.
   */
  private scheduleAnsweredReconciliation(callSid: string, callControlId: string): void {
    const maxAttempts = 12;
    const pollIntervalMs = 2500;
    const initialDelayMs = 3000;

    const poll = async (attempt: number): Promise<void> => {
      const callState = this.callStateService.findOne(callSid);
      if (!callState) {
        this.logger.debug(
          `Reconciliation for ${callSid}: call state no longer exists — stopping (attempt ${String(attempt)}/${String(maxAttempts)})`,
        );
        return;
      }
      if (
        callState.status === CallStatus.COMPLETED ||
        callState.status === CallStatus.FAILED ||
        callState.status === CallStatus.CANCELLED
      ) {
        this.logger.debug(
          `Reconciliation for ${callSid}: call already reached terminal status "${callState.status}" — stopping (attempt ${String(attempt)}/${String(maxAttempts)})`,
        );
        return;
      }
      if (callState.metadata?.telnyxStreamStarted === true) {
        // Note: `status === ACTIVE` is deliberately NOT treated as "done" here — `handleCallAnswered`
        // sets ACTIVE as soon as the call is answered, independent of whether streaming actually
        // attached (see its own comment). A poll attempt that hit "not answered yet" already leaves
        // the call ACTIVE with `telnyxStreamStarted: false`; checking status here would make that
        // look identical to a fully-handled call and stop retrying before media ever attached.
        this.logger.debug(
          `Reconciliation for ${callSid}: media already attached — stopping (attempt ${String(attempt)}/${String(maxAttempts)})`,
        );
        return;
      }

      this.logger.log(
        `🔎 Reconciliation poll ${String(attempt)}/${String(maxAttempts)} for ${callSid} — ` +
          `no call.answered webhook seen yet, checking Telnyx's own call status (current state: ${callState.status})`,
      );

      let telnyxStatus: string;
      try {
        telnyxStatus = await this.telnyxClient.getCallStatus(callControlId);
      } catch (err) {
        this.logger.warn(
          `Reconciliation poll ${String(attempt)}/${String(maxAttempts)} for ${callSid} failed to fetch call status: ${errMsg(err)}`,
        );
        telnyxStatus = 'unknown';
      }

      if (telnyxStatus === 'active') {
        this.logger.warn(
          `⚠️ Reconciliation: ${callSid} is answered on Telnyx's side but call.answered was never delivered — ` +
            `attaching media proactively now (attempt ${String(attempt)}/${String(maxAttempts)}, reason: missing webhook)`,
        );
        const attached = await this.telnyxCallLock.run(callSid, () =>
          this.handleCallAnswered(callSid, callControlId, 'reconciliation_poll'),
        );
        if (attached) {
          return;
        }
        // `is_alive: true` can fire slightly ahead of Telnyx's own call-control state actually
        // reaching "answered" — streaming_start then correctly rejects with "not answered yet"
        // (422/90034). That's not a terminal failure, just early: fall through to the same
        // retry-after-`pollIntervalMs` path used when the call isn't active yet, instead of
        // stopping here and leaving the call to rely solely on the real (possibly still-missing)
        // call.answered webhook — the exact gap that stranded a call in silence in production.
        this.logger.warn(
          `Reconciliation attempt ${String(attempt)}/${String(maxAttempts)} for ${callSid} did not attach media — will retry`,
        );
      }

      if (telnyxStatus === 'ended') {
        this.logger.debug(
          `Reconciliation for ${callSid}: Telnyx reports the call has ended — stopping (attempt ${String(attempt)}/${String(maxAttempts)}); ` +
            `call.hangup webhook will finalize status if it hasn't already`,
        );
        return;
      }

      if (attempt >= maxAttempts) {
        this.logger.warn(
          `⏱️ Reconciliation for ${callSid} gave up after ${String(maxAttempts)} attempts (~${String((maxAttempts * pollIntervalMs) / 1000)}s) — ` +
            `Telnyx call status stayed "${telnyxStatus}" (current local state: ${callState.status}, next expected event: call.answered or call.hangup)`,
        );
        return;
      }

      setTimeout(() => {
        void poll(attempt + 1);
      }, pollIntervalMs);
    };

    setTimeout(() => {
      void poll(1);
    }, initialDelayMs);
  }

  /**
   * Telnyx call-control events (inbound + outbound fallback path).
   * Configure Telnyx webhook URL to: POST /webhook/telnyx/events
   */
  @Post('telnyx/events')
  async handleTelnyxEvents(
    @Body() payload: Record<string, unknown>,
    @Headers('telnyx-signature-ed25519') signatureHeader: string | undefined,
    @Headers('telnyx-timestamp') timestampHeader: string | undefined,
    @Req() req: RequestWithRawBody,
    @Res() res: Response,
  ): Promise<Response> {
    const requestStartedAt = Date.now();

    if (this.isLocalVoiceMode()) {
      return res.status(200).json({ ok: true, skipped: 'VOICE_MODE=local' });
    }

    // Full raw payload at debug level — the single source of truth for "what did Telnyx actually
    // send" when a field turns out missing/malformed. Logged before signature verification so a
    // rejected/malformed webhook is still diagnosable.
    this.logger.debug(`Telnyx webhook payload: ${JSON.stringify(payload)}`);

    const publicKey = this.configService.get<string>('telnyx.publicKey')?.trim() ?? '';
    if (publicKey) {
      const rawBody = getTelnyxWebhookRawBody(req);
      const valid =
        rawBody != null &&
        verifyTelnyxWebhookSignature(publicKey, signatureHeader, timestampHeader, rawBody);
      if (!valid) {
        this.logger.warn('Rejected Telnyx webhook: invalid or missing signature');
        throw new ForbiddenException('Invalid webhook signature');
      }
    } else {
      this.logger.warn(
        'Telnyx webhook signature verification skipped — TELNYX_PUBLIC_KEY not configured. ' +
          'Set it in production (Telnyx Portal → Account Settings → Public Key).',
      );
    }

    const {
      eventId,
      eventType,
      callControlId,
      callLegId,
      callSessionId,
      direction,
      state,
      from,
      to,
      hangupCause,
      sipHangupCause,
    } = this.parseTelnyxPayload(payload);
    if (!eventType || !callControlId) {
      this.logger.warn(`Ignoring Telnyx event: missing event_type/call_control_id`);
      return res.status(200).json({ ok: true, ignored: true });
    }

    const callSid = `TLX_${callControlId}`;
    this.logger.log(
      `📞 Telnyx event ${eventType} for ${callSid} (direction=${direction ?? 'unknown'}, state=${state ?? 'n/a'}, ` +
        `call_control_id=${callControlId}, call_leg_id=${callLegId ?? 'n/a'}, call_session_id=${callSessionId ?? 'n/a'}, event_id=${eventId ?? 'n/a'})`,
    );

    try {
      // Serialize all processing for this call: Telnyx can redeliver an event (slow ack, network
      // blip) or fire overlapping events (call.answered / call.hangup back to back) concurrently.
      // Without this lock, two handlers for the same call_control_id can interleave — e.g. both
      // issuing streaming_start at once (Telnyx 500s on the conflicting command), or a hangup being
      // processed mid-way through a call.answered handler and then getting clobbered by it.
      await this.telnyxCallLock.run(callSid, async () => {
        // Dedup by Telnyx's event id: only skip if a *previous* delivery of this exact event
        // already completed successfully. A previously-failed delivery is left reprocessable so a
        // genuine Telnyx redelivery can still succeed.
        if (eventId && this.telnyxEventDedup.isDuplicate(eventId)) {
          this.logger.log(
            `↩️ Skipping duplicate Telnyx event ${eventType} (${eventId}) for ${callSid}`,
          );
          return;
        }

        if (eventType === 'call.initiated' && isTelnyxInboundInitiated({ direction, state })) {
          const initiatedAt = Date.now();

          const admission = await this.inboundCallAdmission.tryAdmit(callSid);
          if (!admission.admitted) {
            this.logger.warn(
              `[callId=${callSid}] Rejecting inbound Telnyx call — ${admission.reason ?? 'at capacity'}`,
            );
            await this.telnyxClient.endCall(callControlId).catch((err: unknown) => {
              this.logger.warn(
                `[callId=${callSid}] Failed to reject at-capacity call: ${errMsg(err)}`,
              );
            });
            return;
          }

          this.logger.log(`📥 call.initiated (parked) for ${callSid} — resolving inbound script`);
          const resolved = await this.inboundScriptResolver.resolve(from ?? '', to ?? '');
          const metadata = this.inboundScriptResolver.toCallStateMetadata(resolved);
          metadata.provider = 'telnyx+elevenlabs';
          metadata.telephonyProvider = 'telnyx';
          metadata.telnyxCallControlId = callControlId;
          metadata.telnyxBidirectionalCodec = 'L16';
          metadata.telnyxInboundSampleRate = 16000;
          metadata.telnyxIsInbound = true;

          if (!this.callStateService.exists(callSid)) {
            this.callStateService.create({
              callSid,
              phoneNumberFrom: from ?? '',
              phoneNumberTo: to ?? '',
              script: resolved.script,
              model: resolved.model,
              voiceId: resolved.voiceId,
              provider: 'telnyx+elevenlabs',
              status: 'connecting',
              metadata,
              companyId: resolved.companyId,
            });
            this.logger.log(`Created call state for Telnyx inbound: ${callSid}`);
          }

          // TelnyxClient.answerCall already retries transient failures internally (backoff +
          // timeout) and treats "already answered" as a success, so a single call here is enough —
          // no need to duplicate that retry policy at this layer.
          this.logger.log(
            `📤 Sending Call Control "answer" for ${callSid} (parked ${String(Date.now() - initiatedAt)}ms)`,
          );
          try {
            await this.telnyxClient.answerCall(callControlId);
            this.logger.log(
              `📶 Call ${callSid} answered in ${String(Date.now() - initiatedAt)}ms since parked — ` +
                `proceeding straight to media attach instead of waiting on a separate call.answered webhook`,
            );
            // Outbound calls MUST wait for call.answered — only the far end (the callee picking up)
            // knows when that happens. Inbound is different: WE just issued the answer command, and
            // Telnyx's synchronous 200 response already confirms it was accepted. Waiting for a
            // *second*, independently-delivered webhook to confirm what we already know is an
            // unnecessary dependency on at-least-once (not guaranteed) delivery — if that webhook is
            // ever lost or delayed (observed in production: call.initiated itself needed 3 delivery
            // attempts for one call), the caller sits in silence until Telnyx's own park timeout
            // hangs up, with no AI audio ever attempted. Call the exact same handler outbound's real
            // call.answered webhook uses, right now, synchronously in this flow.
            //
            // If the real call.answered webhook does still arrive afterwards, this is entirely
            // idempotent: handleCallAnswered() short-circuits on the `telnyxStreamStarted` metadata
            // flag already set below, and updateStatus() rejects the resulting no-op ACTIVE->ACTIVE
            // transition — so redundant delivery is a harmless no-op, never a duplicate stream.
            await this.handleCallAnswered(callSid, callControlId, 'proactive_after_answer');
          } catch (err) {
            this.logger.error(
              `❌ Failed to answer inbound call ${callSid} after ${String(Date.now() - initiatedAt)}ms — marking FAILED`,
              err instanceof Error ? err.stack : err,
            );
            if (this.callStateService.exists(callSid)) {
              this.callStateService.updateMetadata(callSid, {
                telnyxAnswerFailed: true,
                telnyxAnswerError: errMsg(err),
              });
              this.callStateService.updateStatus(callSid, CallStatus.FAILED);
            }
          }
        } else if (eventType === 'call.initiated') {
          // Outbound leg (direction=outgoing): nothing to do yet — only the callee picking up
          // decides when this becomes answered, so unlike inbound there's no synchronous command
          // result we can act on immediately. But that decision is communicated to us solely via
          // the `call.answered` webhook, which is at-least-once, not guaranteed, delivery — and has
          // been observed in production going missing entirely for an otherwise-healthy call (the
          // callee answered, talked to silence for ~40s, then hung up; no call.answered ever
          // arrived). Start a background safety net now so a lost webhook can't strand the callee
          // in silence for the rest of the call.
          this.scheduleAnsweredReconciliation(callSid, callControlId);
        }

        if (eventType === 'call.answered') {
          await this.handleCallAnswered(callSid, callControlId, 'call.answered webhook');
        }

        if (
          eventType === 'call.hangup' ||
          eventType === 'call.ended' ||
          eventType === 'call.recording.saved'
        ) {
          let neverAnswered = false;
          let alreadyTerminal = false;
          if (eventType === 'call.hangup') {
            const causeParts = [
              hangupCause ? `hangup_cause=${hangupCause}` : null,
              sipHangupCause ? `sip_hangup_cause=${sipHangupCause}` : null,
            ].filter((part): part is string => part != null);
            if (causeParts.length > 0) {
              this.logger.warn(`📞 Telnyx hangup for ${callSid}: ${causeParts.join(', ')}`);
            }

            const existing = this.callStateService.findOne(callSid);
            // Call never reached `call.answered` (status is still INITIATING) — the carrier or
            // destination rejected/failed the call before connecting. Recording this as "completed"
            // would be indistinguishable from a normal call that the agent or caller hung up on
            // purpose, hiding the real failure (e.g. genuine user_busy/486 within ~1s of dialing)
            // from the call record. A call already marked ACTIVE (answered — see above; no longer
            // gated on stream-start success) or already COMPLETED/FAILED/CANCELLED must not be
            // downgraded back to FAILED here.
            neverAnswered = existing?.status === CallStatus.INITIATING;
            alreadyTerminal =
              existing != null &&
              (existing.status === CallStatus.COMPLETED ||
                existing.status === CallStatus.FAILED ||
                existing.status === CallStatus.CANCELLED);
            if (hangupCause || sipHangupCause) {
              this.callStateService.updateMetadata(callSid, {
                telnyxHangupCause: hangupCause,
                telnyxSipHangupCause: sipHangupCause,
              });
            }
          }
          if (!alreadyTerminal && this.callStateService.exists(callSid)) {
            this.callStateService.updateStatus(
              callSid,
              neverAnswered ? CallStatus.FAILED : CallStatus.COMPLETED,
            );
          }
        }

        if (eventId) this.telnyxEventDedup.markSucceeded(eventId);
      });
    } catch (error: unknown) {
      this.logger.error(
        `Telnyx webhook processing failed for ${callSid} (event=${eventType}, event_id=${eventId ?? 'n/a'}) after ${String(Date.now() - requestStartedAt)}ms:`,
        error instanceof Error ? error.stack : error,
      );
    }

    this.logger.log(
      `📞 Telnyx event ${eventType} for ${callSid} processed in ${String(Date.now() - requestStartedAt)}ms`,
    );
    return res.status(200).json({ ok: true });
  }

  @Post('gather')
  async handleGather(
    @Body() dto: any,
    @Query('callSid') callSid: string,
    @Res() res: Response,
  ): Promise<Response> {
    const speechResult = dto.SpeechResult ?? '';
    this.logger.log(`Gather result for ${callSid}: "${speechResult}"`);

    if (!speechResult) {
      return res
        .type('text/xml')
        .send(
          this.webhookService.generateGatherTwiml(
            callSid,
            "I didn't hear anything. Could you please repeat that?",
          ),
        );
    }

    if (!this.callStateService.exists(callSid)) {
      this.logger.warn(`No call state for ${callSid}`);
      return res
        .type('text/xml')
        .send(
          this.webhookService.generateTwiml(
            "Sorry, I'm having trouble with this call. Please try again.",
          ),
        );
    }

    try {
      const aiResponse = await this.conversationService.processUserMessage(callSid, speechResult);
      return res
        .type('text/xml')
        .send(this.webhookService.generateGatherTwiml(callSid, aiResponse));
    } catch (error) {
      this.logger.error(`Error processing speech for ${callSid}:`, error);
      return res
        .type('text/xml')
        .send(
          this.webhookService.generateGatherTwiml(
            callSid,
            "I'm sorry, I encountered an error. Could you please repeat that?",
          ),
        );
    }
  }
}
