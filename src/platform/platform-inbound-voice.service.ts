import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { AgentsService } from '../agents/agents.service';
import { normalizeConversationFlowMode } from '../agents/types/conversation-flow-mode.types';
import { CallScriptService } from '../call-scripts/call-script.service';
import { normalizePhoneNumber } from '../common/utils/phone.util';
import { PromptConverter } from '../common/utils/prompt-converter.util';
import { CompaniesService } from '../companies/companies.service';
import { getEffectiveFlow, getNode, getSayTemplate, getStartNodeId } from '../flows/flow-accessors';
import { buildFlowSystemPrompt } from '../flows/flow-prompt.builder';
import { FlowsService } from '../flows/flows.service';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';
import { PlatformInboundVoiceConfig } from '../models/platform-inbound-voice/platform-inbound-voice-config.entity';
import type { UpsertPlatformInboundVoiceDto } from './dto/upsert-platform-inbound-voice.dto';
import type { UpsertPlatformPhoneRouteDto } from './dto/upsert-platform-phone-route.dto';
import type { ResolvedInboundScript } from '../webhook/types/resolved-inbound-script.types';

/** Postgres unique_violation error code. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

@Injectable()
export class PlatformInboundVoiceService {
  private readonly logger = new Logger(PlatformInboundVoiceService.name);

  constructor(
    @InjectRepository(PlatformInboundVoiceConfig)
    private readonly repo: Repository<PlatformInboundVoiceConfig>,
    private readonly agentsService: AgentsService,
    private readonly callScriptService: CallScriptService,
    private readonly flowsService: FlowsService,
    private readonly companiesService: CompaniesService,
  ) {}

  /** The legacy single platform-default row (phoneNumber IS NULL). */
  async getConfig() {
    const config = await this.repo.findOne({
      where: { phoneNumber: IsNull() },
      order: { updatedAt: 'DESC' },
    });

    if (!config) {
      this.logger.log('No platform inbound voice config found');
      return null;
    }

    return this.attachNames(config);
  }

  private async attachNames(config: PlatformInboundVoiceConfig) {
    // Fetch names for each ID
    const [agent, callScript, flow, company] = await Promise.all([
      config.agentId ? this.agentsService.findOne(config.agentId) : null,
      config.scriptId ? this.callScriptService.findOne(config.scriptId) : null,
      config.flowId ? this.flowsService.findPublishedFlowById(config.flowId) : null,
      config.platformCompanyId ? this.companiesService.findOne(config.platformCompanyId) : null,
    ]);

    // Return config with names instead of IDs
    return {
      ...config,
      agent: agent
        ? {
            id: config.agentId,
            name: agent ? agent.agentName : null,
          }
        : undefined,
      callScript: callScript
        ? {
            id: config.scriptId,
            name: callScript ? callScript.name : null,
          }
        : undefined,
      flow: flow
        ? {
            id: config.flowId,
            name: flow ? flow.name : null,
          }
        : undefined,
      company: company
        ? {
            id: config.platformCompanyId,
            name: company ? company.name : null,
          }
        : undefined,
    };
  }

  /** Create/update the legacy single platform-default row (phoneNumber IS NULL). */
  async upsert(dto: UpsertPlatformInboundVoiceDto): Promise<PlatformInboundVoiceConfig> {
    const existing = await this.repo.findOne({
      where: { phoneNumber: IsNull() },
      order: { updatedAt: 'DESC' },
    });
    const row =
      existing ??
      this.repo.create({
        platformCompanyId: dto.platformCompanyId ?? null,
        routingMode: dto.routingMode,
        agentId: null,
        flowId: null,
        scriptId: null,
        phoneNumber: null,
      });

    row.platformCompanyId = dto.platformCompanyId ?? null;
    row.routingMode = dto.routingMode;
    row.agentId = dto.routingMode === 'agent' ? dto.agentId! : null;
    row.flowId = dto.routingMode === 'flow' ? dto.flowId! : null;
    row.scriptId = dto.routingMode === 'script' ? dto.scriptId! : null;

    const saved = await this.repo.save(row);
    this.logger.log(`Platform inbound voice config saved: mode=${saved.routingMode}`);
    return saved;
  }

  /**
   * When no company matches the called number, apply platform routing before legacy default script / env.
   */
  async tryResolvePlatformDefault(language: string): Promise<ResolvedInboundScript | null> {
    const config = await this.repo.findOne({
      where: { phoneNumber: IsNull() },
      order: { updatedAt: 'DESC' },
    });
    if (!config) return null;
    return this.dispatchRoutingMode(config, language);
  }

  /**
   * Per-company Telnyx number lookup for inbound calls (Tier 1 in `InboundScriptResolverService`).
   * Returns `null` when the number isn't registered, is inactive, or is registered with
   * `routingMode: 'database_default'` — callers fall through to the next resolution tier.
   */
  async tryResolveByPhoneNumber(
    calledNumber: string,
    language: string,
  ): Promise<ResolvedInboundScript | null> {
    const config = await this.findByPhoneNumber(calledNumber);
    if (!config) return null;
    return this.dispatchRoutingMode(config, language);
  }

  private async findByPhoneNumber(phoneNumber: string): Promise<PlatformInboundVoiceConfig | null> {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return null;
    return this.repo.findOne({ where: { phoneNumber: normalized, isActive: true } });
  }

  private async dispatchRoutingMode(
    config: PlatformInboundVoiceConfig,
    language: string,
  ): Promise<ResolvedInboundScript | null> {
    switch (config.routingMode) {
      case 'database_default':
        return null;
      case 'agent':
        return this.resolveFromAgent(config, language);
      case 'flow':
        return this.resolveFromFlow(config, language);
      case 'script':
        return this.resolveFromScript(config, language);
      default:
        return null;
    }
  }

  /**
   * The Telnyx DID to dial/transfer *from* for outbound calls placed on behalf of `companyId`.
   * Returns `null` (never throws) when no active numbered row exists for this company — callers
   * fall through to `TelnyxPhoneNumberService`'s env-based default.
   */
  async resolveOutboundNumber(companyId: string): Promise<string | null> {
    const row = await this.repo.findOne({
      where: { platformCompanyId: companyId, isActive: true, phoneNumber: Not(IsNull()) },
      order: { updatedAt: 'DESC' },
    });
    return row?.phoneNumber ?? null;
  }

  /** All per-company Telnyx number routes (admin listing). */
  async listPhoneRoutes() {
    const rows = await this.repo.find({
      where: { phoneNumber: Not(IsNull()) },
      order: { createdAt: 'ASC' },
    });
    return Promise.all(rows.map(row => this.attachNames(row)));
  }

  /**
   * Create/update a per-company Telnyx number route. Rejects reassigning a number already owned
   * by a different company — that must be an explicit delete then re-create, since it decides
   * which company's calls a real phone number serves.
   */
  async upsertPhoneRoute(dto: UpsertPlatformPhoneRouteDto): Promise<PlatformInboundVoiceConfig> {
    const normalized = normalizePhoneNumber(dto.phoneNumber);
    if (!normalized) {
      throw new BadRequestException('phoneNumber must contain a valid phone number');
    }

    const existing = await this.repo.findOne({ where: { phoneNumber: normalized } });
    if (existing && existing.platformCompanyId !== dto.platformCompanyId) {
      throw new ConflictException(
        `${normalized} is already routed to a different company. Delete that route before reassigning it.`,
      );
    }

    const row =
      existing ??
      this.repo.create({
        phoneNumber: normalized,
        platformCompanyId: dto.platformCompanyId,
        routingMode: dto.routingMode,
        agentId: null,
        flowId: null,
        scriptId: null,
      });

    row.platformCompanyId = dto.platformCompanyId;
    row.routingMode = dto.routingMode;
    row.agentId = dto.routingMode === 'agent' ? dto.agentId! : null;
    row.flowId = dto.routingMode === 'flow' ? dto.flowId! : null;
    row.scriptId = dto.routingMode === 'script' ? dto.scriptId! : null;
    row.isActive = true;

    try {
      const saved = await this.repo.save(row);
      this.logger.log(`Phone route saved: ${normalized} -> company ${dto.platformCompanyId}`);
      return saved;
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`${normalized} is already routed to a different company.`);
      }
      throw err;
    }
  }

  async deactivatePhoneRoute(id: string): Promise<void> {
    const result = await this.repo.update({ id, phoneNumber: Not(IsNull()) }, { isActive: false });
    if (!result.affected) {
      throw new NotFoundException(`Phone route ${id} not found`);
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
    );
  }

  private async resolveFromAgent(
    config: PlatformInboundVoiceConfig,
    language: string,
  ): Promise<ResolvedInboundScript | null> {
    if (!config.agentId) return null;
    try {
      const agent = await this.agentsService.getForCall(config.agentId, { requirePublished: true });
      const ids = this.agentsService.getResponseEngineIds(agent);
      /** Scoped tenant for (flowId+company) lookup; null ⇒ global published flow by id. */
      const companyIdForFlow = agent.companyId ?? config.platformCompanyId ?? null;

      if (ids.llmId != null && ids.flowId == null && ids.scriptId == null) {
        this.logger.warn(
          `Platform inbound agent "${agent.agentName}" uses LLM-only engine; falling back to database default`,
        );
        return null;
      }

      const voiceId = agent.voiceId ?? undefined;
      const interruptionSensitivity = agent.interruptionSensitivity;
      const maxCallDurationMs = agent.maxCallDurationMs;

      if (ids.flowId != null) {
        const flow = await this.loadFlowForPlatformInbound(ids.flowId, companyIdForFlow);
        if (!flow) {
          this.logger.warn(
            `Flow ${ids.flowId} not found for platform inbound agent "${agent.agentName}". Set platformCompanyId to scope by
tenant, or publish the flow.`,
          );
          return null;
        }
        const companyLabel = await this.resolveCompanyDisplayName(flow.companyId);
        const effectiveFlow = getEffectiveFlow(flow.flow);
        const startId = getStartNodeId(effectiveFlow);
        const script = buildFlowSystemPrompt({
          flow: effectiveFlow,
          currentNodeId: startId,
          slots: {},
          mode: normalizeConversationFlowMode(agent.conversationFlowMode),
        });
        const initialNode = getNode(effectiveFlow, startId);
        const initialTemplate = getSayTemplate(initialNode);
        const firstMessage = initialTemplate
          ? this.renderTemplate(initialTemplate, {
              company: companyLabel,
            })
          : 'Hello! How can I help you today?';

        this.flowsService.trackUsage(flow.id, true).catch(err => {
          this.logger.error('trackUsage flow', err);
        });

        const gp = agent.globalPrompt?.trim();
        return {
          script,
          model: 'gpt-4o-mini',
          voiceId,
          firstMessage,
          language,
          companyId: flow.companyId ?? undefined,
          scriptId: flow.scriptId ?? undefined,
          scriptName: flow.name,
          flowId: flow.id,
          flowName: flow.name,
          flowCompanyId: flow.companyId,
          embeddedFlow: effectiveFlow,
          agentId: agent.id,
          agentName: agent.agentName,
          ...(gp ? { agentGlobalPrompt: gp } : {}),
          interruptionSensitivity,
          maxCallDurationMs,
          conversationFlowMode: normalizeConversationFlowMode(agent.conversationFlowMode),
        };
      }

      if (ids.scriptId != null) {
        const callScript = await this.callScriptService.findOne(ids.scriptId);
        if (callScript.callType !== 'inbound' && callScript.callType !== 'both') {
          throw new BadRequestException(
            `Script "${callScript.name}" must be inbound or both for platform inbound agent routing`,
          );
        }
        if (!callScript.isActive) {
          throw new BadRequestException(`Script "${callScript.name}" is not active`);
        }

        this.callScriptService.trackUsage(callScript.id, true).catch(err => {
          this.logger.error('trackUsage script', err);
        });

        const gpScript = agent.globalPrompt?.trim();
        return {
          script: PromptConverter.autoConvert(callScript.script),
          model: callScript.model,
          voiceId: voiceId ?? callScript.voiceId ?? undefined,
          firstMessage: callScript.firstMessage ?? undefined,
          scriptId: callScript.id,
          scriptName: callScript.name,
          language,
          companyId:
            callScript.companyId ?? agent.companyId ?? config.platformCompanyId ?? undefined,
          agentId: agent.id,
          agentName: agent.agentName,
          ...(gpScript ? { agentGlobalPrompt: gpScript } : {}),
          interruptionSensitivity,
          maxCallDurationMs,
        };
      }

      this.logger.warn(
        `Platform inbound agent ${agent.id} has no flow or script in response engine`,
      );
      return null;
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof BadRequestException) throw e;
      this.logger.error('resolveFromAgent failed', e);
      return null;
    }
  }

  private async resolveFromFlow(
    config: PlatformInboundVoiceConfig,
    language: string,
  ): Promise<ResolvedInboundScript | null> {
    if (!config.flowId) return null;
    try {
      const flow = await this.loadFlowForPlatformInbound(config.flowId, config.platformCompanyId);
      if (flow) {
        const companyLabel = await this.resolveCompanyDisplayName(flow.companyId);
        const effectiveFlow = getEffectiveFlow(flow.flow);
        const startId = getStartNodeId(effectiveFlow);
        const script = buildFlowSystemPrompt({
          flow: effectiveFlow,
          currentNodeId: startId,
          slots: {},
        });
        const initialNode = getNode(effectiveFlow, startId);
        const initialTemplate = getSayTemplate(initialNode);
        const firstMessage = initialTemplate
          ? this.renderTemplate(initialTemplate, {
              company: companyLabel,
            })
          : 'Hello! How can I help you today?';

        this.flowsService.trackUsage(flow.id, true).catch(err => {
          this.logger.error('trackUsage flow', err);
        });

        return {
          script,
          model: 'gpt-4o-mini',
          firstMessage,
          language,
          companyId: flow.companyId ?? undefined,
          scriptId: flow.scriptId ?? undefined,
          scriptName: flow.name,
          flowId: flow.id,
          flowName: flow.name,
          flowCompanyId: flow.companyId,
          embeddedFlow: effectiveFlow,
        };
      } else {
        this.logger.warn(
          `Flow ${config.flowId} not found for platform inbound. Set platformCompanyId to scope by tenant, or publish the flow.`,
        );
        return null;
      }
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof BadRequestException) throw e;
      this.logger.error('resolveFromFlow failed', e);
      return null;
    }
  }

  private async resolveFromScript(
    config: PlatformInboundVoiceConfig,
    language: string,
  ): Promise<ResolvedInboundScript | null> {
    if (!config.scriptId) return null;
    try {
      const callScript = await this.callScriptService.findOne(config.scriptId);
      if (callScript.callType !== 'inbound' && callScript.callType !== 'both') {
        throw new BadRequestException(
          `Script "${callScript.name}" must be inbound or both for platform inbound`,
        );
      }
      if (!callScript.isActive) {
        throw new BadRequestException(`Script "${callScript.name}" is not active`);
      }

      this.callScriptService.trackUsage(callScript.id, true).catch(err => {
        this.logger.error('trackUsage script', err);
      });

      return {
        script: PromptConverter.autoConvert(callScript.script),
        model: callScript.model,
        voiceId: callScript.voiceId ?? undefined,
        firstMessage: callScript.firstMessage ?? undefined,
        scriptId: callScript.id,
        scriptName: callScript.name,
        language,
        companyId: callScript.companyId ?? config.platformCompanyId ?? undefined,
      };
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof BadRequestException) throw e;
      this.logger.error('resolveFromScript failed', e);
      return null;
    }
  }

  private renderTemplate(template: string, slots: Record<string, any>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
      const value = slots[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  /**
   * With tenant: flow must exist under that company and be published.
   * Without tenant (global): any published flow with this id (unique across DB).
   */
  private async loadFlowForPlatformInbound(
    flowId: string,
    scopedCompanyId: string | null,
  ): Promise<ConversationFlow | null> {
    if (scopedCompanyId) {
      const flow = await this.flowsService.getDraft(flowId, scopedCompanyId);
      if (!flow) return null;
      if (flow.status !== 'published') {
        throw new BadRequestException(
          `Flow "${flow.name}" is not published. Publish it before using it for inbound.`,
        );
      }
      return flow;
    }
    const flow = await this.flowsService.findPublishedFlowById(flowId);
    if (!flow) {
      throw new NotFoundException(
        `Published flow ${flowId} not found. Set platformCompanyId to scope by tenant, or publish the flow.`,
      );
    }
    return flow;
  }

  /** Display name for flow templates; works without a config company id. */
  private async resolveCompanyDisplayName(companyId: string | null | undefined): Promise<string> {
    if (!companyId) return 'Hexa AI';
    try {
      const company = await this.companiesService.findOne(companyId);
      return company.name || 'Hexa AI';
    } catch {
      return 'Hexa AI';
    }
  }
}
