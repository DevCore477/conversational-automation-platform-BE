import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { Agent } from '../models/agents/agent.entity';
import type { ResponseEngine } from './types/response-engine.types';
import type { CreateAgentInput } from './dto/create-agent.dto';
import { normalizeConversationFlowMode } from './types/conversation-flow-mode.types';
import { UpdateAgentDto } from './dto/update-agent.dto';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
  ) {}

  async create(dto: CreateAgentInput): Promise<Agent> {
    const agent = this.agentRepository.create({
      agentName: dto.agentName,
      globalPrompt:
        dto.globalPrompt != null && dto.globalPrompt.trim() !== '' ? dto.globalPrompt.trim() : null,
      companyId: dto.companyId ?? null,
      channel: dto.channel,
      conversationFlowMode: normalizeConversationFlowMode(dto.conversationFlowMode),
      responseEngine: dto.responseEngine as ResponseEngine,
      language: dto.language,
      voiceId: dto.voiceId ?? null,
      maxCallDurationMs: dto.maxCallDurationMs,
      interruptionSensitivity: dto.interruptionSensitivity,
      dataStorageSetting: dto.dataStorageSetting,
      userDtmfOptions: dto.userDtmfOptions ?? null,
      isPublished: dto.isPublished,
      postCallAnalysisModel: dto.postCallAnalysisModel ?? null,
    });
    const saved = await this.agentRepository.save(agent);
    this.logger.log(`Created agent: ${saved.agentName} (${saved.id})`);
    return saved;
  }

  async findAll(companyId?: string | null): Promise<Agent[]> {
    const where: Record<string, unknown> =
      companyId != null ? { companyId, isPublished: true } : {};
    return this.agentRepository.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }
  async findAllSince(date: Date, companyId?: string | null): Promise<Agent[]> {
    const where: Record<string, unknown> = {
      updatedAt: Between(date, new Date()),
      isPublished: true,
    };
    if (companyId != null) where.companyId = companyId;
    return this.agentRepository.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  async findByIds(ids: string[], companyId?: string | null): Promise<Agent[]> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const where = companyId != null ? { id: In(unique), companyId } : { id: In(unique) };
    return this.agentRepository.find({ where });
  }

  /**
   * Dashboard: counts of agents by publish state and channel.
   */
  async getStats(
    companyId?: string | null,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<{
    total: number;
    published: number;
    unpublished: number;
    byChannel: Record<string, number>;
  }> {
    let whereQuery: Record<string, unknown> = { isPublished: true };
    if (period) {
      const now = new Date();
      const periodMs = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = new Date(now.getTime() - (periodMs[period] || periodMs.day));
      whereQuery = { ...whereQuery, createdAt: Between(cutoff, now) };
    }
    if (companyId) {
      whereQuery = { ...whereQuery, companyId };
    }
    const agents = await this.agentRepository.find({
      where: whereQuery,
      order: { updatedAt: 'DESC' },
    });
    const byChannel: Record<string, number> = {};
    for (const a of agents) {
      byChannel[a.channel] = (byChannel[a.channel] ?? 0) + 1;
    }
    const published = agents.filter(a => a.isPublished).length;
    return {
      total: agents.length,
      published,
      unpublished: agents.length - published,
      byChannel,
    };
  }

  async findByCompany(companyId: string): Promise<Agent[]> {
    return this.agentRepository.find({
      where: { companyId },
      order: { updatedAt: 'DESC' },
    });
  }

  async findOne(id: string, companyId?: string | null): Promise<Agent | null> {
    const where: { id: string; companyId?: string } = { id };
    if (companyId != null) where.companyId = companyId;
    const agent = await this.agentRepository.findOne({ where });
    if (!agent) {
      return null;
      // throw new NotFoundException(`Agent ${id} not found`);
    }
    return agent;
  }

  async update(id: string, dto: UpdateAgentDto, companyId?: string | null): Promise<Agent> {
    const agent = await this.findOne(id, companyId);
    if (!agent) {
      throw new NotFoundException(`Agent ${id} not found`);
    }
    if (dto.agentName != null) agent.agentName = dto.agentName;
    if (dto.conversationFlowMode !== undefined) {
      agent.conversationFlowMode = normalizeConversationFlowMode(dto.conversationFlowMode);
    }
    if (dto.globalPrompt !== undefined) {
      agent.globalPrompt =
        dto.globalPrompt == null || dto.globalPrompt.trim() === '' ? null : dto.globalPrompt.trim();
    }
    if (dto.companyId !== undefined) agent.companyId = dto.companyId ?? null;
    if (dto.channel != null) agent.channel = dto.channel;
    if (dto.responseEngine != null) agent.responseEngine = dto.responseEngine as ResponseEngine;
    if (dto.language != null) agent.language = dto.language;
    if (dto.voiceId !== undefined) agent.voiceId = dto.voiceId ?? null;
    if (dto.maxCallDurationMs != null) agent.maxCallDurationMs = dto.maxCallDurationMs;
    if (dto.interruptionSensitivity != null)
      agent.interruptionSensitivity = dto.interruptionSensitivity;
    if (dto.dataStorageSetting != null) agent.dataStorageSetting = dto.dataStorageSetting;
    if (dto.userDtmfOptions !== undefined) agent.userDtmfOptions = dto.userDtmfOptions ?? null;
    if (dto.isPublished !== undefined) agent.isPublished = dto.isPublished;
    if (dto.postCallAnalysisModel !== undefined)
      agent.postCallAnalysisModel = dto.postCallAnalysisModel ?? null;
    agent.version = agent.version + 1;
    return this.agentRepository.save(agent);
  }

  async remove(id: string, companyId?: string | null): Promise<void> {
    const agent = await this.findOne(id, companyId);
    if (!agent) {
      throw new NotFoundException(`Agent ${id} not found`);
    }
    await this.agentRepository.remove(agent);
    this.logger.log(`Removed agent: ${agent.agentName} (${id})`);
  }

  /**
   * Get agent by ID for use in a call. Validates that the agent is published when required.
   */
  async getForCall(agentId: string, options?: { requirePublished?: boolean }): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId } });
    if (!agent) {
      throw new NotFoundException(`Agent ${agentId} not found`);
    }
    if (options?.requirePublished && !agent.isPublished) {
      throw new BadRequestException(`Agent "${agent.agentName}" is not published`);
    }
    return agent;
  }

  /**
   * Resolve response engine to IDs used by the call layer.
   * Returns { flowId?, scriptId?, llmId? } so the caller can load flow/script/llm accordingly.
   */
  getResponseEngineIds(agent: Agent): {
    flowId?: string;
    flowIds?: string[];
    scriptId?: string;
    llmId?: string;
  } {
    const engine = agent.responseEngine;
    switch (engine.type) {
      case 'conversation-flow':
        return {
          flowId: engine.conversation_flow_id,
          flowIds: engine.conversation_flow_ids,
        };
      case 'script':
        return { scriptId: engine.script_id };
      case 'llm':
        return { llmId: engine.llm_id };
      default:
        return {};
    }
  }
}
