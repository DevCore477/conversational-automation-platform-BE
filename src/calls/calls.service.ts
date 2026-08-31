import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';

import { AgentsService } from '../agents/agents.service';
import {
  type ConversationFlowMode,
  normalizeConversationFlowMode,
} from '../agents/types/conversation-flow-mode.types';
import { CallScriptService } from '../call-scripts/call-script.service';
import { TelnyxClient } from '../clients/telnyx/telnyx.client';
import { TelnyxPhoneNumberService } from '../clients/telnyx/telnyx-phone-number.service';
import { TwilioClient } from '../clients/twilio/twilio.client';
import { VoiceClientFactory } from '../clients/voice-client/voice-client.factory';
import { getLanguageFromCountryCode } from '../common/utils/phone-country.util';
import { normalizePhoneNumber } from '../common/utils/phone.util';
import { PromptConverter } from '../common/utils/prompt-converter.util';
import { buildVetClinicNorwegianScript } from '../common/utils/vet-clinic-script.util';
import { CompaniesService } from '../companies/companies.service';
import { PlatformInboundVoiceService } from '../platform/platform-inbound-voice.service';
import { buildFlowSystemPrompt } from '../flows/flow-prompt.builder';
import { getEffectiveFlow, getStartNodeId, getNode, getSayTemplate } from '../flows/flow-accessors';
import { FlowsService } from '../flows/flows.service';
import type { ConversationFlowJSON } from '../flows/types/flows.types';
import { type MakeCallInput, MakeCallDto } from './dto/make-call.dto';
import { CallStatus, type CallState } from './types/call-state.types';
import { CallStateService } from './services/call-state.service';
import { ScriptOpeningMessageService } from './services/script-opening-message.service';
import type { TrustedCallerAttribution } from './utils/trusted-caller-attribution.util';
import { CallRecordService } from './services/call-record.service';
import { fromTelnyxCallSid, toTelnyxCallSid } from './utils/telnyx-call-sid.util';
import { ElevenLabsVoiceBridgeService } from '../voice/elevanlabs.voice-bridge-service.service';
import { VoiceTerminalReplService } from '../voice/voice-terminal-repl.service';
import { CallRecord } from '../models/calls/call-record.entity';
import type { ValidatedUser } from '../auth/services/token-validation.service';

/** Maps Twilio REST error codes to clear, user-facing messages. */
function getTwilioErrorMessage(error: { code?: number; message?: string }): string {
  const code = error.code;
  const fallback =
    error.message != null && error.message !== ''
      ? `Twilio: ${error.message}`
      : 'Call setup failed. Please check your Twilio account and phone number.';
  if (code === undefined) return fallback;
  switch (code) {
    case 20003:
      return 'Twilio authentication failed. Check your Account SID and Auth Token.';
    case 21211:
      return 'Invalid phone number. Please use a valid number in E.164 format (e.g. +1234567890).';
    case 21212:
      return 'Invalid caller (From) number. Check your Twilio phone number configuration.';
    case 21608:
      return 'Twilio account has insufficient balance. Add credits to your Twilio account to make calls.';
    case 21614:
      return 'The number is not a valid mobile number.';
    case 31003:
      return 'Invalid webhook URL. Check your Twilio voice webhook configuration.';
    case 20404:
      return 'Twilio resource not found. The account or number may be invalid.';
    default:
      return fallback;
  }
}

function isTwilioLikeError(err: unknown): err is { code?: number; message?: string } {
  return typeof err === 'object' && err !== null && ('code' in err || 'message' in err);
}

function getTelnyxErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return `Telnyx: ${error.message}`;
  }
  return 'Call setup failed on Telnyx. Check your Telnyx connection ID, phone number, and API key.';
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly twilioClient: TwilioClient,
    private readonly telnyxClient: TelnyxClient,
    private readonly telnyxPhoneNumberService: TelnyxPhoneNumberService,
    private readonly platformInboundVoice: PlatformInboundVoiceService,
    private readonly configService: ConfigService,
    private readonly callStateService: CallStateService,
    private readonly callScriptService: CallScriptService,
    private readonly flowsService: FlowsService,
    private readonly companiesService: CompaniesService,
    private readonly agentsService: AgentsService,
    private readonly scriptOpeningMessageService: ScriptOpeningMessageService,
    private readonly callRecordService: CallRecordService,
    private readonly voiceClientFactory: VoiceClientFactory,
    @Inject(forwardRef(() => VoiceTerminalReplService))
    private readonly voiceTerminalRepl: VoiceTerminalReplService,
    @Inject(forwardRef(() => ElevenLabsVoiceBridgeService))
    private readonly voiceBridge: ElevenLabsVoiceBridgeService,
  ) {}

  async makeCall(dto: MakeCallDto, companyId?: string, trustedCaller?: TrustedCallerAttribution) {
    // Normalize destination to E.164 so Norwegian and other international numbers work (e.g. 47 12 34 56 78 → +4712345678)
    const normalizedTo = normalizePhoneNumber(dto.to);
    if (!normalizedTo) {
      throw new BadRequestException(
        'Invalid phone number. Please use a valid number (e.g. +4712345678 for Norway).',
      );
    }

    let script: string;
    let model: string;
    let voiceId: string | undefined;
    let scriptId: string | undefined;
    let firstMessage: string | undefined;
    let scriptName: string | undefined;
    let flowId: string | undefined;
    let flowIds: string[] | undefined; // Optional additional flow IDs from agent (for routing/future use)
    let isFlowCall = false;
    let flowData: ConversationFlowJSON | undefined; // Store flow data for later use
    /** Agent-level settings to pass to call (voice, interruption, etc.). Used when makeCall is via agentId. */
    let agentSettings:
      | {
          agentId?: string;
          agentName?: string;
          agentGlobalPrompt?: string;
          interruptionSensitivity?: number;
          maxCallDurationMs?: number;
          conversationFlowMode?: ConversationFlowMode;
        }
      | undefined;

    /** Flow stepping mode for conversation-flow calls (agent setting or default rigid). */
    let conversationFlowModeForFlow: ConversationFlowMode = 'rigid';

    /** Company for flow fetch and call state: from request or from agent when using agent with conversation-flow. */
    let companyIdForFlow: string | null = companyId ?? null;

    // Priority 0: Agent (resolves to flowId, scriptId, or llmId from agent config; applies agent voice, language, interruption, etc.)
    let effectiveDto: MakeCallInput = {
      to: dto.to,
      agentId: dto.agentId,
      scriptId: dto.scriptId,
      script: dto.script,
      model: dto.model,
      flowId: dto.flowId,
      voiceId: dto.voiceId,
      firstMessage: dto.firstMessage,
      language: dto.language,
      endCallAfterFirstMessage: dto.endCallAfterFirstMessage,
      bookingId: dto.bookingId,
    };

    if (dto.agentId != null) {
      const agent = await this.agentsService.getForCall(dto.agentId, {
        requirePublished: true,
      });
      const ids = this.agentsService.getResponseEngineIds(agent);
      if (ids.flowId != null) {
        effectiveDto = { ...effectiveDto, flowId: ids.flowId };
        flowIds = ids.flowIds; // Optional additional flows (e.g. for future intent-based routing)
      }
      if (ids.scriptId != null) {
        effectiveDto = { ...effectiveDto, scriptId: ids.scriptId };
      }
      if (effectiveDto.language == null && agent.language) {
        const lang = agent.language.startsWith('en') ? 'en' : agent.language.split('-')[0];
        effectiveDto = { ...effectiveDto, language: lang };
      }
      if (effectiveDto.voiceId == null && agent.voiceId != null) {
        effectiveDto = { ...effectiveDto, voiceId: agent.voiceId };
      }
      const trimmedGlobal = agent.globalPrompt?.trim();
      if (ids.flowId != null) {
        conversationFlowModeForFlow = normalizeConversationFlowMode(agent.conversationFlowMode);
      }
      agentSettings = {
        agentId: agent.id,
        agentName: agent.agentName,
        ...(trimmedGlobal ? { agentGlobalPrompt: trimmedGlobal } : {}),
        interruptionSensitivity: agent.interruptionSensitivity,
        maxCallDurationMs: agent.maxCallDurationMs,
        ...(ids.flowId != null ? { conversationFlowMode: conversationFlowModeForFlow } : {}),
      };
      if (companyIdForFlow == null && agent.companyId != null) {
        companyIdForFlow = agent.companyId;
        this.logger.log(`🏢 Using agent's company ${agent.companyId} for flow resolution`);
      }
      this.logger.log(`🤖 Using agent: "${agent.agentName}" (${agent.id})`);
      if (ids.llmId != null && ids.flowId == null && ids.scriptId == null) {
        throw new BadRequestException(
          `Agent "${agent.agentName}" uses an LLM response engine (llm_id=${ids.llmId}). LLM-based agents are not yet supported for outbound calls. Use a conversation-flow or script response engine.`,
        );
      }
    }

    // Priority 1: Flow (if flowId provided)
    if (effectiveDto.flowId) {
      // if (!companyIdForFlow) {
      //   throw new BadRequestException(
      //     'Company context is required for flow-based calls. Provide companyId (e.g. via auth) or use an agent that belongs to a company.',
      //   );
      // }
      try {
        const flow = await this.flowsService.getDraft(effectiveDto.flowId);
        companyIdForFlow = companyIdForFlow ?? flow?.companyId ?? null;
        const company = companyIdForFlow
          ? await this.companiesService.findOne(companyIdForFlow)
          : null;
        if (flow?.status !== 'published') {
          const flowLabel =
            flow?.name != null && flow.name !== '' ? flow.name : effectiveDto.flowId;
          throw new BadRequestException(
            `Flow "${flowLabel}" is not published. Please publish the flow first.`,
          );
        }

        // Build script from flow (unwrap nested { start, flow: { nodes, start_node_id }, intents } if present)
        const effectiveFlow = getEffectiveFlow(flow.flow);
        const startId = getStartNodeId(effectiveFlow);
        const initialNode = getNode(effectiveFlow, startId);
        script = buildFlowSystemPrompt({
          flow: effectiveFlow,
          currentNodeId: startId,
          slots: {},
          mode: conversationFlowModeForFlow,
        });

        model = 'gpt-4o-mini'; // Default model for flows
        const initialTemplate = getSayTemplate(initialNode);
        firstMessage = initialTemplate
          ? this.renderTemplate(initialTemplate, {
              company: company?.name,
            })
          : 'Hello! How can I help you today?';

        flowId = flow.id;
        isFlowCall = true;
        flowData = effectiveFlow; // Store unwrapped flow data

        this.logger.log(`🌊 Using published flow: "${flow.name}" for outbound call`);
      } catch (error) {
        this.logger.error(`❌ Error fetching flow ${effectiveDto.flowId}:`, error);
        throw error;
      }
    }
    // Priority 2: Script (if scriptId provided)
    else if (effectiveDto.scriptId) {
      try {
        const callScript = await this.callScriptService.findOne(effectiveDto.scriptId);
        companyIdForFlow = companyIdForFlow ?? callScript.companyId ?? null;

        // Validate that the script is for outbound calls
        if (callScript.callType !== 'outbound' && callScript.callType !== 'both') {
          throw new BadRequestException(
            `Script "${callScript.name}" is not configured for outbound calls`,
          );
        }

        if (!callScript.isActive) {
          throw new BadRequestException(`Script "${callScript.name}" is not active`);
        }

        // Auto-convert JSON prompts to natural language
        script = PromptConverter.autoConvert(callScript.script);
        model = callScript.model;
        voiceId = callScript.voiceId ?? undefined;
        scriptId = callScript.id;
        scriptName = callScript.name;

        // Vet Clinic NO: inject Norwegian prompt and language so agent speaks Norwegian throughout
        const vetScriptName = this.configService.get<string>('vetClinic.vetScriptName');
        if (vetScriptName && callScript.name === vetScriptName) {
          const doctorNames = this.configService.get<string>('vetClinic.doctorNames') ?? '';
          const alternateWeekendSlots =
            this.configService.get<string>('vetClinic.alternateWeekendSlots') ?? '';
          script = buildVetClinicNorwegianScript(doctorNames, alternateWeekendSlots);
          firstMessage =
            callScript.firstMessage !== ''
              ? callScript.firstMessage
              : 'Hallo, du ringer til dyreklinikken. Hvordan kan jeg hjelpe deg i dag?';
          this.logger.log(`📝 Using vet script "${callScript.name}" for outbound call (Norwegian)`);
        } else {
          script = PromptConverter.autoConvert(callScript.script);
          firstMessage = callScript.firstMessage !== '' ? callScript.firstMessage : undefined;
          this.logger.log(`📝 Using database script: "${callScript.name}" for outbound call`);
          if (PromptConverter.isJsonString(callScript.script)) {
            this.logger.log(
              `🔄 Converted JSON prompt to natural language (${String(script.length)} chars)`,
            );
          }
        }
      } catch (error) {
        this.logger.error(`❌ Error fetching script ${effectiveDto.scriptId}:`, error);
        throw error;
      }
    } else {
      // Use provided script and model (legacy support)
      if (!dto.script || !dto.model) {
        throw new BadRequestException(
          'Either agentId, scriptId, flowId, or both script and model must be provided for outbound calls',
        );
      }
      // Auto-convert JSON prompts to natural language
      script = PromptConverter.autoConvert(dto.script);
      model = dto.model;
      voiceId = dto.voiceId;
      firstMessage = dto.firstMessage;

      this.logger.log(`📝 Using inline script for outbound call`);

      if (PromptConverter.isJsonString(dto.script)) {
        this.logger.log(
          `🔄 Converted JSON prompt to natural language (${String(script.length)} chars)`,
        );
      }
    }

    // Script / inline raw script: when no explicit firstMessage, generate a contextual opener from the full script (flows unchanged).
    if (!isFlowCall && !firstMessage?.trim()) {
      const vetScriptName = this.configService.get<string>('vetClinic.vetScriptName');
      const isVetOutbound = scriptName != null && scriptName === vetScriptName;
      if (!isVetOutbound) {
        const languageForOpening =
          effectiveDto.language ?? getLanguageFromCountryCode(normalizedTo);
        const generated = await this.scriptOpeningMessageService.generateFromScript(
          script,
          languageForOpening,
        );
        if (generated) {
          firstMessage = generated;
          this.logger.log(
            `🎯 Generated contextual first message from script (${String(generated.length)} chars)`,
          );
        }
      }
    }

    // Override voiceId if provided in DTO or from agent (takes priority over script voiceId)
    if (effectiveDto.voiceId) {
      voiceId = effectiveDto.voiceId;
      this.logger.log(`🎤 Using custom voice ID override from call request: ${voiceId}`);
    } else if (voiceId) {
      this.logger.log(`🎤 Using voice ID from script: ${voiceId}`);
    } else {
      this.logger.log(`⚠️ No voice ID specified, will use agent default voice`);
    }

    const metadata: Record<string, unknown> = {
      callType: 'outbound',
      ...(trustedCaller ? { trustedCallerAttribution: trustedCaller } : {}),
      ...(scriptId ? { scriptId } : {}),
      ...(flowId ? { flowId } : {}),
      ...(flowIds?.length ? { flowIds } : {}),
      ...(firstMessage ? { firstMessage } : {}),
      ...(scriptName ? { scriptName } : {}),
      ...(voiceId ? { voiceId } : {}),
      ...(dto.endCallAfterFirstMessage === true ? { endCallAfterFirstMessage: true } : {}),
      ...(dto.bookingId ? { bookingId: dto.bookingId } : {}),
      ...(effectiveDto.language ? { language: effectiveDto.language } : {}),
      // Store flow data if it's a flow call
      ...(isFlowCall && flowData ? { flow: flowData } : {}),
      ...(isFlowCall ? { conversationFlowMode: conversationFlowModeForFlow } : {}),
      // Agent-level settings: used by voice bridge for interruption, max duration, etc.
      ...(agentSettings?.agentId ? { agentId: agentSettings.agentId } : {}),
      ...(agentSettings?.agentName ? { agentName: agentSettings.agentName } : {}),
      ...(agentSettings?.agentGlobalPrompt
        ? { agentGlobalPrompt: agentSettings.agentGlobalPrompt }
        : {}),
      ...(agentSettings?.interruptionSensitivity != null
        ? { interruptionSensitivity: agentSettings.interruptionSensitivity }
        : {}),
      ...(agentSettings?.maxCallDurationMs != null
        ? { maxCallDurationMs: agentSettings.maxCallDurationMs }
        : {}),
    };

    // Default language when not explicitly provided: prefer OUR OWN outbound Telnyx number's
    // country over the destination's — a company with a dedicated Netherlands number wants Dutch
    // as the default for every call it places, regardless of who's being called (e.g. calling a
    // Pakistani customer from the NL number should still open in Dutch). Only overrides the
    // destination-based guess when the own-number lookup resolves to something other than the
    // 'en' fallback (mirrors resolveLanguageForInbound's same "calledTo first, unless it's just
    // the unmatched 'en' default" pattern for inbound calls). This is only the starting language —
    // an explicit request or the caller's detected speech still switches it once the call is live.
    if (!metadata.language) {
      const resolvedCompanyIdForLanguage = companyIdForFlow ?? companyId ?? null;
      const ownOutboundNumber = resolvedCompanyIdForLanguage
        ? ((await this.platformInboundVoice.resolveOutboundNumber(resolvedCompanyIdForLanguage)) ??
          this.telnyxPhoneNumberService.resolveFromNumber(resolvedCompanyIdForLanguage))
        : '';
      const ownNumberLanguage = ownOutboundNumber
        ? getLanguageFromCountryCode(ownOutboundNumber)
        : 'en';
      if (ownNumberLanguage !== 'en') {
        metadata.language = ownNumberLanguage;
        this.logger.log(`🌐 Language for outbound call set from own number: ${ownNumberLanguage}`);
      } else {
        metadata.language = getLanguageFromCountryCode(normalizedTo);
        this.logger.log(
          `🌐 Language for outbound call set from destination: ${String(metadata.language)}`,
        );
      }
    }
    // Vet script: ensure ElevenLabs uses Norwegian for the whole conversation
    const vetScriptName = this.configService.get<string>('vetClinic.vetScriptName');
    if (scriptName === vetScriptName) {
      metadata.language = 'no';
    }

    const scriptUsedPayload =
      scriptId != null && scriptId !== ''
        ? { id: scriptId, source: 'database' as const }
        : flowId != null && flowId !== ''
          ? { id: flowId, source: 'flow' as const }
          : { source: 'inline' as const };

    if (this.shouldUseTerminalOutboundInsteadOfTwilio()) {
      const callSid = `CA_LOCAL_${crypto.randomBytes(8).toString('hex')}`;
      metadata.localVoiceSimulation = true;

      const callState = this.callStateService.create({
        callSid,
        phoneNumberFrom: 'local-terminal',
        phoneNumberTo: normalizedTo,
        script,
        model,
        voiceId,
        provider: 'local-terminal-ai',
        status: 'connecting',
        metadata,
        companyId: companyIdForFlow ?? companyId ?? undefined,
      });

      this.callStateService.updateStatus(callSid, CallStatus.ACTIVE);

      const terminalAttached = this.voiceTerminalRepl.attachOutboundTerminalSession(callSid);

      this.logger.log(
        `✅ Local voice simulation ${callSid} — model: ${model}, voiceId: ${voiceId ?? 'default'}, type: ${isFlowCall ? 'flow' : 'script'} (Twilio skipped)`,
      );

      if (scriptId) {
        void this.callScriptService.trackUsage(scriptId, true).catch((error: unknown) => {
          this.logger.error(`Failed to track script usage:`, error);
        });
      }
      if (flowId) {
        void this.flowsService.trackUsage(flowId, true).catch((error: unknown) => {
          this.logger.error(`Failed to track flow usage:`, error);
        });
      }

      return {
        success: true,
        callSid,
        localVoiceSimulation: true,
        terminalSessionAttached: terminalAttached,
        message: terminalAttached
          ? 'Twilio skipped (local/dev outbound simulation). Continue in the server terminal.'
          : 'Twilio skipped. No interactive terminal or stdin is busy — close other terminal sessions.',
        callState: {
          status: callState.status,
          model: callState.model,
          createdAt: callState.createdAt,
        },
        scriptUsed: scriptUsedPayload,
      };
    }

    const baseUrl = this.configService.getOrThrow<string>('webhook.baseUrl');
    const twilioFromNumber = this.configService.getOrThrow<string>('app.twilioPhoneNumber');
    const voiceAgentWebhook = `${baseUrl}/webhook/voice-agent`;
    const telnyxWebhook = `${baseUrl}/webhook/telnyx/events`;
    const resolvedCompanyIdForNumber = companyIdForFlow ?? companyId ?? null;
    const dbOutboundNumber = resolvedCompanyIdForNumber
      ? await this.platformInboundVoice.resolveOutboundNumber(resolvedCompanyIdForNumber)
      : null;
    const telnyxFromNumber =
      dbOutboundNumber ??
      this.telnyxPhoneNumberService.resolveFromNumber(resolvedCompanyIdForNumber);
    const outboundProvider =
      this.configService.get<'auto' | 'telnyx' | 'twilio'>('calls.outboundTelephonyProvider') ??
      'auto';

    let callSid: string;
    let provider = 'twilio+elevenlabs';
    let fromNumber = twilioFromNumber;

    if (outboundProvider === 'telnyx') {
      // Telnyx is the only real telephony provider for this deployment — dial it directly. No
      // Twilio health check, no dial attempt, no fallback: attempting Twilio first here would only
      // guarantee a wasted network round trip (or worse, silently place the call through the wrong
      // provider if Twilio credentials happen to be validly configured for something unrelated).
      this.logger.log(`📞 Dialing Telnyx directly (OUTBOUND_TELEPHONY_PROVIDER=telnyx)`);
      if (!this.telnyxClient.isConfigured()) {
        throw new BadRequestException(
          'Telnyx is not configured (set TELNYX_API_KEY and TELNYX_CONNECTION_ID).',
        );
      }
      if (telnyxFromNumber === '') {
        throw new BadRequestException(
          'Telnyx outbound requires TELNYX_PHONE_NUMBER (a Telnyx-owned DID assigned to your Call Control app).',
        );
      }
      try {
        const callControlId = await this.telnyxClient.call(
          normalizedTo,
          telnyxFromNumber,
          telnyxWebhook,
        );
        callSid = toTelnyxCallSid(callControlId);
        provider = 'telnyx+elevenlabs';
        fromNumber = telnyxFromNumber;
        metadata.telnyxCallControlId = callControlId;
      } catch (telnyxError: unknown) {
        const telnyxMessage = getTelnyxErrorMessage(telnyxError);
        this.logger.error(`Telnyx outbound dial failed: ${telnyxMessage}`);
        throw new BadRequestException(telnyxMessage);
      }
    } else {
      try {
        await this.twilioClient.healthCheck();
        callSid = await this.twilioClient.call(normalizedTo, twilioFromNumber, voiceAgentWebhook);
      } catch (err: unknown) {
        const twilioErr = isTwilioLikeError(err) ? err : {};
        const code = twilioErr.code;
        const twilioMessage = getTwilioErrorMessage(twilioErr);
        this.logger.warn(
          `Twilio error during makeCall (code=${code !== undefined ? String(code) : 'unknown'}): ${twilioMessage}`,
        );

        if (outboundProvider === 'twilio') {
          throw new BadRequestException(twilioMessage);
        }
        if (!this.telnyxClient.isConfigured()) {
          throw new BadRequestException(
            `${twilioMessage} Telnyx fallback is not configured (set TELNYX_API_KEY and TELNYX_CONNECTION_ID).`,
          );
        }
        if (telnyxFromNumber === '') {
          throw new BadRequestException(
            `${twilioMessage} Telnyx fallback requires TELNYX_PHONE_NUMBER (a Telnyx-owned DID assigned to your Call Control app).`,
          );
        }

        try {
          this.logger.warn(
            `Falling back to Telnyx outbound dial from ${telnyxFromNumber} to ${normalizedTo}`,
          );
          const callControlId = await this.telnyxClient.call(
            normalizedTo,
            telnyxFromNumber,
            telnyxWebhook,
          );
          callSid = toTelnyxCallSid(callControlId);
          provider = 'telnyx+elevenlabs';
          fromNumber = telnyxFromNumber;
          metadata.telnyxCallControlId = callControlId;
        } catch (telnyxError: unknown) {
          const telnyxMessage = getTelnyxErrorMessage(telnyxError);
          this.logger.error(`Telnyx fallback failed during makeCall: ${telnyxMessage}`);
          throw new BadRequestException(`${twilioMessage} Fallback failed: ${telnyxMessage}`);
        }
      }
    }

    metadata.provider = provider;
    metadata.telephonyProvider = provider.startsWith('telnyx') ? 'telnyx' : 'twilio';
    if (provider.startsWith('telnyx')) {
      metadata.telnyxBidirectionalCodec = 'L16';
      metadata.telnyxInboundSampleRate = 16000;
    }

    this.logger.log(`📞 Initiated outbound ${provider} call ${callSid} to ${normalizedTo}`);

    const callState = this.callStateService.create({
      callSid,
      phoneNumberFrom: fromNumber,
      phoneNumberTo: normalizedTo,
      script,
      model,
      voiceId,
      provider,
      status: 'connecting',
      metadata,
      companyId: companyIdForFlow ?? companyId ?? undefined,
    });

    this.logger.log(
      `✅ Created call state for ${callSid} — model: ${model}, voiceId: ${voiceId ?? 'default'}, type: ${isFlowCall ? 'flow' : 'script'}`,
    );

    // Open the TTS WebSocket now, while the callee's phone is still ringing, so the greeting
    // doesn't pay ElevenLabs' connect+TLS handshake after they answer. Best-effort/fire-and-forget:
    // the voice bridge falls back to a fresh (cold) client if this hasn't completed by answer time.
    this.voiceBridge.prewarmOutboundTts(callSid, { voiceId, metadata });

    // Track usage if applicable
    if (scriptId) {
      void this.callScriptService.trackUsage(scriptId, true).catch((error: unknown) => {
        this.logger.error(`Failed to track script usage:`, error);
      });
    }
    if (flowId) {
      void this.flowsService.trackUsage(flowId, true).catch((error: unknown) => {
        this.logger.error(`Failed to track flow usage:`, error);
      });
    }

    const twimlUrl = `${baseUrl}/webhook?callSid=${callSid}`;

    return {
      success: true,
      callSid,
      provider,
      twimlUrl,
      callState: {
        status: callState.status,
        model: callState.model,
        createdAt: callState.createdAt,
      },
      scriptUsed: scriptUsedPayload,
    };
  }

  /**
   * Outbound dial uses Twilio only when this is false. Local dev often lacks Twilio credentials —
   * use VOICE_MODE=local, SKIP_TWILIO_OUTBOUND=true, or NODE_ENV=development|test (unless
   * USE_REAL_TWILIO_OUTBOUND=true).
   */
  private shouldUseTerminalOutboundInsteadOfTwilio(): boolean {
    if (this.voiceClientFactory.getMode() === 'local') {
      return true;
    }
    const callsCfg = this.configService.get<{
      skipTwilioOutbound?: boolean;
      useRealTwilioOutboundDev?: boolean;
    }>('calls');
    if (callsCfg?.skipTwilioOutbound === true) {
      return true;
    }
    const nodeEnv = process.env.NODE_ENV ?? '';
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      if (callsCfg?.useRealTwilioOutboundDev === true) {
        return false;
      }
      return true;
    }
    return false;
  }

  /** Terminal Twilio call statuses – call is finished. */
  private static readonly TERMINAL_CALL_STATUSES = new Set([
    'completed',
    'ended',
    'hangup',
    'busy',
    'failed',
    'canceled',
    'cancelled',
    'no-answer',
  ]);

  /**
   * Wait until the call has ended (terminal status) or timeout.
   * Polls Twilio every pollIntervalMs. Use for sequential/queued outbound calls.
   * If Twilio returns an error (e.g. 20404 after call torn down), treats call as ended so the next call can proceed.
   * @returns The terminal call status (e.g. "completed", "busy", "no-answer") or undefined if timeout.
   */
  async waitForCallToEnd(
    callSid: string,
    options: {
      pollIntervalMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<string | undefined> {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 300_000; // 5 min max

    if (
      this.voiceClientFactory.getMode() === 'local' &&
      CallsService.isLocalTerminalSimulatedCallSid(callSid)
    ) {
      return this.waitForLocalTerminalSessionToEnd(callSid, pollIntervalMs, timeoutMs);
    }
    const telnyxCallControlId = fromTelnyxCallSid(callSid);

    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const status =
          telnyxCallControlId != null
            ? await this.telnyxClient.getCallStatus(telnyxCallControlId)
            : await this.twilioClient.getCallStatus(callSid);
        if (CallsService.TERMINAL_CALL_STATUSES.has(status)) {
          this.logger.log(`Call ${callSid} ended with status: ${status}`);
          return status;
        }
      } catch (err) {
        // Call may be torn down (e.g. 20404); exit so next driver is not blocked. Do not return "completed" so we do not mark booking as completed.
        this.logger.warn(
          `Call ${callSid} status check failed (proceeding to next): ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    this.logger.warn(`waitForCallToEnd timed out for ${callSid} after ${String(timeoutMs)}ms`);
    return undefined;
  }

  /** Outbound local simulation (`CA_LOCAL_*`) or idle terminal (`CA_TERMINAL_*`). */
  private static isLocalTerminalSimulatedCallSid(callSid: string): boolean {
    return callSid.startsWith('CA_LOCAL_') || callSid.startsWith('CA_TERMINAL_');
  }

  /**
   * Poll in-memory call status until terminal state (no Twilio).
   */
  private async waitForLocalTerminalSessionToEnd(
    callSid: string,
    pollIntervalMs: number,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.voiceBridge.hasSession(callSid)) {
        this.logger.log(`Local terminal session ${callSid} bridge ended`);
        return 'completed';
      }
      const state = this.callStateService.findOne(callSid);
      if (
        state &&
        (state.status === CallStatus.COMPLETED ||
          state.status === CallStatus.FAILED ||
          state.status === CallStatus.CANCELLED)
      ) {
        this.logger.log(`Local terminal session ${callSid} ended with status: ${state.status}`);
        return 'completed';
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    this.logger.warn(
      `waitForCallToEnd timed out for local terminal ${callSid} after ${String(timeoutMs)}ms`,
    );
    return undefined;
  }

  getCallState(callSid: string) {
    return this.callStateService.get(callSid);
  }

  async getAllCalls(companyId?: string) {
    const dbCalls = await this.callRecordService.findAll(200, companyId);
    const liveCalls = this.callStateService.getAll(companyId);

    const mergedMap = CallsService.mergeDbAndLiveCalls(dbCalls, liveCalls);
    const entries = Array.from(mergedMap.values());

    entries.sort((a, b) => {
      const ta = CallsService.callListSortTime(a);
      const tb = CallsService.callListSortTime(b);
      return tb - ta;
    });

    return Promise.all(entries.map(entry => this.toCallListRow(entry)));
  }

  /** Union of DB row + optional in-memory state for the same `callSid`. */
  private static mergeDbAndLiveCalls(
    dbCalls: CallRecord[],
    liveCalls: CallState[],
  ): Map<string, { record?: CallRecord; live?: CallState }> {
    const map = new Map<string, { record?: CallRecord; live?: CallState }>();

    for (const record of dbCalls) {
      map.set(record.callSid, { record, live: undefined });
    }

    for (const live of liveCalls) {
      const cur = map.get(live.callSid);
      if (cur) {
        cur.live = live;
      } else {
        map.set(live.callSid, { record: undefined, live });
      }
    }

    return map;
  }

  private static callListSortTime(entry: { record?: CallRecord; live?: CallState }): number {
    const created = entry.record?.createdAt ?? entry.live?.createdAt;
    const updated = entry.live?.updatedAt ?? entry.record?.updatedAt;
    return Math.max(created?.getTime() ?? 0, updated?.getTime() ?? 0);
  }

  async toCallListRow(entry: {
    record?: CallRecord;
    live?: CallState;
  }): Promise<Partial<CallRecord> & { status: string }> {
    const { record, live } = entry;

    const metaRecord =
      record?.metadata != null && typeof record.metadata === 'object' ? record.metadata : {};

    const metaLive =
      live?.metadata != null && typeof live.metadata === 'object' ? live.metadata : {};

    // Live overrides record
    const meta: Record<string, any> = { ...metaRecord, ...metaLive };

    const callSid = record?.callSid ?? live?.callSid ?? '';
    const status = live?.status ?? record?.status ?? '';
    const model = (live?.model ?? record?.model ?? '').trim();
    const createdAt = record?.createdAt ?? live?.createdAt ?? new Date();

    // Clean async lookups
    const scriptName =
      meta.scriptId && typeof meta.scriptId === 'string'
        ? (await this.callScriptService.getOneScript(meta.scriptId))?.name
        : undefined;

    const flowName =
      meta.flowId && typeof meta.flowId === 'string'
        ? (await this.flowsService.getDraft(meta.flowId))?.name
        : undefined;

    // Proper agent resolution
    let agentName = meta.agentName ? String(meta.agentName) : undefined;

    if (!agentName && meta.agentId) {
      const agent =
        typeof meta.agentId === 'string' ? await this.agentsService.findOne(meta.agentId) : null;
      agentName = agent?.agentName ?? 'Unknown Agent';
    }

    return {
      callSid,
      status,
      createdAt,
      model,
      phoneNumberFrom: record?.phoneNumberFrom ?? live?.phoneNumberFrom ?? '',
      phoneNumberTo: record?.phoneNumberTo ?? live?.phoneNumberTo ?? '',
      metadata: {
        firstMessage: meta.firstMessage ?? null,
        scriptName: scriptName ?? null,
        flowName: flowName ?? null,
        agentName: agentName ?? null,
        trustedCallerAttribution: meta.trustedCallerAttribution ?? null,
        inboundInsight: meta.inboundInsight ?? null,
        callType: meta.callType ?? null,
      },
      conversationTranscript: record?.conversationTranscript ?? null,
    };
  }

  getStats(companyId?: string) {
    return this.callStateService.getStats(companyId);
  }

  /**
   * Persisted call row (DB): transcript, duration, metadata, etc.
   */
  async getPersistedCallRecord(callSid: string, user: ValidatedUser): Promise<Partial<CallRecord>> {
    const record = await this.callRecordService.findOneByCallSid(callSid);
    if (!record) {
      throw new NotFoundException(`Call record not found for ${callSid}`);
    }
    if (!CallsService.canAccessPersistedCallRecord(record, user)) {
      throw new ForbiddenException('You do not have access to this call record');
    }

    const scriptName =
      record.metadata.scriptId && typeof record.metadata.scriptId === 'string'
        ? (await this.callScriptService.findOne(record.metadata.scriptId)).name
        : null;

    const flowName =
      record.metadata.flowId && typeof record.metadata.flowId === 'string'
        ? (await this.flowsService.getDraft(record.metadata.flowId))?.name
        : null;

    const agentName =
      record.metadata.agentName ??
      (record.metadata.agentId && typeof record.metadata.agentId === 'string'
        ? (await this.agentsService.findOne(record.metadata.agentId))?.agentName
        : null);

    return {
      callSid: record.callSid,
      status: record.status,
      companyId: record.companyId,
      phoneNumberFrom: record.phoneNumberFrom,
      phoneNumberTo: record.phoneNumberTo,
      conversationTranscript: record.conversationTranscript,
      metadata: {
        callType: record.metadata.callType,
        scriptId: record.metadata.scriptId,
        scriptName: scriptName,
        flowId: record.metadata.flowId,
        flowName: flowName,
        agentId: record.metadata.agentId,
        agentName: agentName,
        voiceId: record.metadata.voiceId,
        firstMessage: record.metadata.firstMessage,
        trustedCallerAttribution: record.metadata.trustedCallerAttribution ?? null,
      },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      duration: record.duration,
    };
  }

  private static canAccessPersistedCallRecord(record: CallRecord, user: ValidatedUser): boolean {
    if (user.role === 'admin') return true;
    if (user.companyId != null && record.companyId === user.companyId) return true;
    const meta = record.metadata.trustedCallerAttribution;
    if (
      meta &&
      typeof meta === 'object' &&
      record.companyId == null &&
      'userId' in meta &&
      typeof (meta as TrustedCallerAttribution).userId === 'string' &&
      user.id === (meta as TrustedCallerAttribution).userId
    ) {
      return true;
    }
    return false;
  }

  // Helper method for template rendering
  private renderTemplate(template: string, slots: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, key: string) => {
      const value = slots[key];
      if (value === undefined || value === null) {
        return '';
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      return '';
    });
  }
}
