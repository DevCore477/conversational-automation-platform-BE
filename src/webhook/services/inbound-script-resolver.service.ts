import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CallScriptService } from '../../call-scripts/call-script.service';
import {
  getLanguageFromCountryCode,
  isNorwegianNumber,
} from '../../common/utils/phone-country.util';
import { PromptConverter } from '../../common/utils/prompt-converter.util';
import { buildVetClinicNorwegianScript } from '../../common/utils/vet-clinic-script.util';
import { CompaniesService } from '../../companies/companies.service';
import { PlatformInboundVoiceService } from '../../platform/platform-inbound-voice.service';
import type { ResolvedInboundScript } from '../types/resolved-inbound-script.types';

const DEFAULT_SCRIPT = 'You are a helpful AI assistant.';
const DEFAULT_MODEL = 'gpt-4';
const DEFAULT_VET_FIRST_MESSAGE =
  'Hallo, du ringer til dyreklinikken. Hvordan kan jeg hjelpe deg i dag?';

@Injectable()
export class InboundScriptResolverService {
  private readonly logger = new Logger(InboundScriptResolverService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly callScriptService: CallScriptService,
    private readonly companiesService: CompaniesService,
    private readonly platformInboundVoice: PlatformInboundVoiceService,
  ) {}

  /**
   * Resolves script, model, voice, first message and language for an inbound call.
   * - calledTo: the number the user is calling (clinic/business number) → matches company → loads that company's script
   * - callerFrom: caller's number; used for language when called number does not imply a specific language (e.g. Norwegian caller → respond in Norwegian)
   * - language: Norwegian callers (+47) → Norwegian; else called number's country; else caller's country
   */
  async resolve(callerFrom: string, calledTo: string): Promise<ResolvedInboundScript> {
    // Tier 1: exact Telnyx-number match -> that company's own agent/flow/script config. Takes
    // priority over the company.phone/settings.inboundPhoneNumbers tier below because that one
    // only ever resolves a call script, never an agent or flow.
    const language = this.resolveLanguageForInbound(callerFrom, calledTo);
    const byNumber = await this.platformInboundVoice.tryResolveByPhoneNumber(calledTo, language);
    if (byNumber) return byNumber;

    const company = await this.companiesService.findByInboundPhone(calledTo);
    if (company) {
      const companyResult = await this.tryResolveCompanyScript(company.id, calledTo, callerFrom);
      if (companyResult) return companyResult;
      this.logger.warn(
        `No inbound script found for company "${company.name}" (${company.id}), using default inbound`,
      );
    }

    return this.resolveDefaultInbound(callerFrom, calledTo);
  }

  /**
   * Tries to load the company's default inbound script.
   * Language: from called number's country; if that is English (e.g. non-Norwegian number), fall back to caller's country so Norwegian callers get Norwegian.
   * Vet clinics: per-company config in company.settings.vetClinic overrides global config.
   */
  private async tryResolveCompanyScript(
    companyId: string,
    calledTo: string,
    callerFrom: string,
  ): Promise<ResolvedInboundScript | null> {
    const callScript = await this.callScriptService.findDefaultInboundByCompany(companyId);
    if (!callScript) return null;

    const company = await this.companiesService.findOne(companyId);
    const language = this.resolveLanguageForInbound(callerFrom, calledTo);

    let script = callScript.script;
    const vetConfig = this.configService.get<{
      vetScriptName?: string;
      doctorNames?: string;
      alternateWeekendSlots?: string;
    }>('vetClinic');
    const vetScriptName = vetConfig?.vetScriptName;
    if (vetScriptName && callScript.name === vetScriptName) {
      const companyVet = (
        company.settings as { vetClinic?: { doctorNames?: string; alternateWeekendSlots?: string } }
      )?.vetClinic;
      const doctorNames = companyVet?.doctorNames ?? vetConfig?.doctorNames ?? '';
      const alternateWeekendSlots =
        companyVet?.alternateWeekendSlots ?? vetConfig?.alternateWeekendSlots ?? '';
      script = buildVetClinicNorwegianScript(doctorNames, alternateWeekendSlots);
    }

    const firstMessage =
      callScript.firstMessage ?? (language === 'no' ? DEFAULT_VET_FIRST_MESSAGE : undefined);

    this.logger.log(
      `Inbound call to ${calledTo}: using company script "${callScript.name}" (language: ${language})`,
    );
    this.trackUsage(callScript.id);

    return {
      script: PromptConverter.autoConvert(script),
      model: callScript.model,
      voiceId: callScript.voiceId ?? undefined,
      firstMessage,
      scriptId: callScript.id,
      scriptName: callScript.name,
      language,
      companyId,
    };
  }

  /**
   * Language for inbound:
   * 1. Norwegian callers (+47) always get Norwegian (even if the business line is foreign or maps to another language).
   * 2. Else use the called number's country when it maps to a non-default language.
   * 3. Else use the caller's country (e.g. +1 business line + Swedish caller → sv).
   */
  private resolveLanguageForInbound(callerFrom: string, calledTo: string): string {
    if (isNorwegianNumber(callerFrom)) {
      this.logger.debug(`Inbound language: Norwegian caller (${callerFrom}) → no`);
      return 'no';
    }
    const fromCalled = getLanguageFromCountryCode(calledTo);
    if (fromCalled !== 'en') return fromCalled;
    return getLanguageFromCountryCode(callerFrom);
  }

  /**
   * Resolves default inbound script from DB or env fallback.
   * Uses caller/called numbers to set language (e.g. Norwegian caller or called number +47 → Norwegian).
   */
  private async resolveDefaultInbound(
    callerFrom?: string,
    calledTo?: string,
  ): Promise<ResolvedInboundScript> {
    const language =
      callerFrom != null && calledTo != null
        ? this.resolveLanguageForInbound(callerFrom, calledTo)
        : 'en';

    try {
      const platformResolved = await this.platformInboundVoice.tryResolvePlatformDefault(language);
      if (platformResolved) {
        this.logger.log(`Platform inbound routing applied (language: ${language})`);
        return platformResolved;
      }
    } catch (err) {
      this.logger.error('Platform inbound routing failed:', err);
      throw err;
    }

    try {
      const defaultScript = await this.callScriptService.findDefaultByType('inbound');
      if (defaultScript) {
        this.logger.log(
          `Using database script: "${defaultScript.name}" (${defaultScript.callType}) for inbound call (language: ${language})`,
        );
        this.trackUsage(defaultScript.id);
        return {
          script: PromptConverter.autoConvert(defaultScript.script),
          model: defaultScript.model,
          voiceId: defaultScript.voiceId ?? undefined,
          firstMessage: defaultScript.firstMessage ?? undefined,
          scriptId: defaultScript.id,
          scriptName: defaultScript.name,
          language,
        };
      }
    } catch (err) {
      this.logger.error('Error fetching default inbound script, using fallback:', err);
    }

    this.logger.warn('No default inbound script in database, using env fallback');
    return {
      script: this.configService.get<string>('app.inboundCallScript', DEFAULT_SCRIPT),
      model: this.configService.get<string>('app.inboundCallModel', DEFAULT_MODEL),
      language,
      scriptName: 'env fallback',
    };
  }

  /**
   * Builds metadata for CallState from a resolved script (language, firstMessage, etc.).
   */
  toCallStateMetadata(resolved: ResolvedInboundScript): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      callType: 'inbound',
      language: resolved.language,
    };
    if (resolved.scriptId) meta.scriptId = resolved.scriptId;
    if (resolved.scriptName) meta.scriptName = resolved.scriptName;
    if (resolved.firstMessage) meta.firstMessage = resolved.firstMessage;
    if (resolved.voiceId) meta.voiceId = resolved.voiceId;
    if (resolved.companyId) meta.companyId = resolved.companyId;
    if (resolved.flowId) meta.flowId = resolved.flowId;
    if (resolved.flowCompanyId) meta.flowCompanyId = resolved.flowCompanyId;
    if (resolved.flowName) meta.flowName = resolved.flowName;
    if (resolved.embeddedFlow) meta.flow = resolved.embeddedFlow;
    if (resolved.agentId) meta.agentId = resolved.agentId;
    if (resolved.agentName) meta.agentName = resolved.agentName;
    if (resolved.agentGlobalPrompt) meta.agentGlobalPrompt = resolved.agentGlobalPrompt;
    if (resolved.interruptionSensitivity != null) {
      meta.interruptionSensitivity = resolved.interruptionSensitivity;
    }
    if (resolved.maxCallDurationMs != null) {
      meta.maxCallDurationMs = resolved.maxCallDurationMs;
    }
    if (resolved.conversationFlowMode != null) {
      meta.conversationFlowMode = resolved.conversationFlowMode;
    }
    return meta;
  }

  private trackUsage(scriptId: string): void {
    this.callScriptService.trackUsage(scriptId, true).catch(err => {
      this.logger.error('Failed to track script usage', err);
    });
  }
}
