import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, In, IsNull, Not, Repository } from 'typeorm';

import {
  getEffectiveFlow,
  getStartNodeId,
  getNodesMap,
  getNode,
  getListen,
  getTransitions,
  isEndNode,
  isTransferCallNode,
  getTransferDialTo,
  getTransferFlowId,
  getTransferAgentId,
  getSayTemplate,
  getPosition,
  getIntents,
} from './flow-accessors';
import { ConversationFlowJSON, type ElevenLabsToolDefinition } from './types/flows.types';
import { AgentsService } from '../agents/agents.service';
import { isConversationFlowEngine } from '../agents/types/response-engine.types';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';

@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(
    @InjectRepository(ConversationFlow)
    private readonly flowRepo: Repository<ConversationFlow>,
    private readonly agentsService: AgentsService,
  ) {}

  async createDraft(params: {
    companyId: string;
    name: string;
    scriptId?: string | null;
    flow: ConversationFlowJSON;
  }) {
    const entity = this.flowRepo.create({
      companyId: params.companyId,
      name: params.name,
      scriptId: params.scriptId ?? null,
      status: 'draft',
      version: 1,
      flow: params.flow,
      publishedAt: null,
      deletedAt: null,
    });
    return this.flowRepo.save(entity);
  }

  async updateDraft(flowId: string, companyId: string, flow: ConversationFlowJSON, name?: string) {
    const existing = await this.flowRepo.findOne({
      where: { id: flowId, companyId },
    });
    if (!existing) throw new NotFoundException('Flow not found');

    // if (existing.status !== 'draft') {
    //   throw new BadRequestException('Only draft flows can be updated');
    // }

    existing.flow = flow;
    if (typeof name === 'string' && name.trim() !== '') {
      existing.name = name.trim();
    }
    return this.flowRepo.save(existing);
  }

  async publish(flowId: string, companyId: string) {
    const existing = await this.flowRepo.findOne({
      where: { id: flowId, companyId },
    });
    if (!existing) throw new NotFoundException('Flow not found');

    // archive previously published flows for this company (optional)
    // await this.flowRepo.update({ companyId, status: 'published' }, { status: 'archived' });

    existing.status = 'published';
    existing.publishedAt = new Date();
    existing.version = existing.version + 1;

    return this.flowRepo.save(existing);
  }

  async updateFlowStatus(
    flowId: string,
    companyId: string,
    status: 'draft' | 'published' | 'archived',
  ) {
    const existing = await this.flowRepo.findOne({
      where: { id: flowId, companyId },
    });
    if (!existing) throw new NotFoundException('Flow not found');

    existing.status = status;
    if (status === 'published') {
      existing.publishedAt = new Date();
      existing.version = existing.version + 1;
    }
    return this.flowRepo.save(existing);
  }

  /**
   * Published flow linked to a call script (e.g. default inbound script → flow with matching scriptId).
   */
  async findPublishedByScriptId(
    scriptId: string,
    companyId: string,
  ): Promise<ConversationFlow | null> {
    return this.flowRepo.findOne({
      where: {
        scriptId,
        companyId,
        status: 'published',
        deletedAt: IsNull(),
      },
      order: { publishedAt: 'DESC' },
    });
  }

  /**
   * Published flow by id only (no company filter). Used for platform-global inbound routing.
   */
  async findPublishedFlowById(flowId: string): Promise<ConversationFlow | null> {
    return this.flowRepo.findOne({
      where: { id: flowId, status: 'published', deletedAt: IsNull() },
    });
  }

  async getPublishedByCompany(companyId: string, flowId?: string) {
    const baseWhere: FindOptionsWhere<ConversationFlow> = {
      companyId,
      status: 'published',
      deletedAt: IsNull(),
    };

    if (flowId != null) {
      const flow = await this.flowRepo.findOne({
        where: { ...baseWhere, id: flowId },
      });
      if (!flow) throw new NotFoundException('Published flow not found');
      return [flow];
    } else {
      const flows = await this.flowRepo.find({
        where: baseWhere,
        order: { publishedAt: 'DESC' },
      });
      if (flows.length === 0) throw new NotFoundException('No published flow for company');
      return flows;
    }
  }

  async list(companyId: string) {
    return this.flowRepo.find({
      where: { companyId, deletedAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
  }

  async listAll() {
    return this.flowRepo.find({
      where: { deletedAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
  }

  async listSince(date: Date, companyId?: string) {
    const where: FindOptionsWhere<ConversationFlow> = {
      updatedAt: Between(date, new Date()),
      deletedAt: IsNull(),
      status: 'published',
    };
    if (companyId) {
      where.companyId = companyId;
    }
    return this.flowRepo.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  async listAllSince(date: Date, companyId?: string) {
    const where: FindOptionsWhere<ConversationFlow> = {
      updatedAt: Between(date, new Date()),
      deletedAt: IsNull(),
      status: 'published',
    };
    if (companyId) {
      where.companyId = companyId;
    }
    return this.flowRepo.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  /** All non-deleted flows (any status), optionally scoped by company — for dashboard performance. */
  async listEvery(companyId?: string) {
    const where: FindOptionsWhere<ConversationFlow> = { deletedAt: IsNull() };
    if (companyId) {
      where.companyId = companyId;
    }
    return this.flowRepo.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Get flow statistics (for dashboard). When companyId is omitted, returns global stats.
   */
  async getStats(
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<{
    total: number;
    published: number;
    draft: number;
    archived: number;
  }> {
    const where: FindOptionsWhere<ConversationFlow> = { deletedAt: IsNull() };
    if (period) {
      const now = new Date();
      const periodMs = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = new Date(now.getTime() - (periodMs[period] || periodMs.day));
      where.createdAt = Between(cutoff, now);
    }
    if (companyId) {
      where.companyId = companyId;
    }
    const flows = await this.flowRepo.find({ where });
    const published = flows.filter(f => f.status === 'published').length;
    const draft = flows.filter(f => f.status === 'draft').length;
    const archived = flows.filter(f => f.status === 'archived').length;
    return { total: flows.length, published, draft, archived };
  }

  /**
   * Aggregated usage counters across flows (dashboard overview).
   */
  async getUsageTotals(
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<{
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
  }> {
    const qb = this.flowRepo
      .createQueryBuilder('f')
      .select('COALESCE(SUM(f.totalCalls), 0)', 'totalCalls')
      .addSelect('COALESCE(SUM(f.successfulCalls), 0)', 'successfulCalls')
      .addSelect('COALESCE(SUM(f.failedCalls), 0)', 'failedCalls')
      .where('f.deletedAt IS NULL');

    if (period) {
      const now = new Date();
      const periodMs = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = new Date(now.getTime() - (periodMs[period] || periodMs.day));
      qb.andWhere('f.createdAt >= :cutoff', { cutoff });
    }
    if (companyId) {
      qb.andWhere('f.companyId = :companyId', { companyId });
    }

    const row = await qb.getRawOne<{
      totalCalls: string;
      successfulCalls: string;
      failedCalls: string;
    }>();

    return {
      totalCalls: parseInt(row?.totalCalls ?? '0', 10),
      successfulCalls: parseInt(row?.successfulCalls ?? '0', 10),
      failedCalls: parseInt(row?.failedCalls ?? '0', 10),
    };
  }

  /**
   * Find flows by IDs (for enriching call activity with flow names).
   * @param includeDeleted - when true, includes soft-deleted flows so past calls can show flow names
   */
  async findByIds(flowIds: string[], includeDeleted = false): Promise<ConversationFlow[]> {
    if (flowIds.length === 0) return [];
    const unique = [...new Set(flowIds)];
    const where: FindOptionsWhere<ConversationFlow> = { id: In(unique) };
    if (!includeDeleted) {
      where.deletedAt = IsNull();
    }
    return this.flowRepo.find({
      where,
      select: ['id', 'name', 'status'],
      ...(includeDeleted ? { withDeleted: true } : {}),
    });
  }

  /**
   * Find flows linked to the given script IDs (for dashboard top scripts).
   */
  async findFlowsByScriptIds(scriptIds: string[], companyId?: string): Promise<ConversationFlow[]> {
    if (scriptIds.length === 0) return [];
    const where: FindOptionsWhere<ConversationFlow> = {
      scriptId: In(scriptIds),
      deletedAt: IsNull(),
    };
    if (companyId) {
      where.companyId = companyId;
    }
    return this.flowRepo.find({
      where,
      select: ['id', 'name', 'status', 'scriptId'],
    });
  }

  async getDraft(flowId: string, companyId?: string) {
    const flow = await this.flowRepo.findOne({
      where: { id: flowId, companyId, deletedAt: IsNull() },
    });
    if (flow) return flow;
    else return null;
    // if (!flow) throw new NotFoundException('Flow not found');
    // return flow;
  }

  /**
   * Soft delete a flow (sets deletedAt timestamp)
   */
  async softDelete(
    flowId: string,
    companyId: string,
  ): Promise<{ success: boolean; message: string }> {
    const existing = await this.flowRepo.findOne({
      where: { id: flowId, companyId },
    });

    if (!existing) {
      throw new NotFoundException('Flow not found');
    }

    if (existing.deletedAt) {
      throw new ConflictException('Flow is already deleted');
    }

    existing.deletedAt = new Date();
    await this.flowRepo.save(existing);

    return {
      success: true,
      message: `Flow "${existing.name}" has been moved to trash`,
    };
  }

  /**
   * Restore a soft-deleted flow
   */
  async restore(flowId: string, companyId: string): Promise<{ success: boolean; message: string }> {
    const existing = await this.flowRepo.findOne({
      where: { id: flowId, companyId },
      withDeleted: true, // Include soft-deleted records
    });

    if (!existing) {
      throw new NotFoundException('Flow not found');
    }

    if (!existing.deletedAt) {
      throw new ConflictException('Flow is not deleted');
    }

    existing.deletedAt = null;
    await this.flowRepo.save(existing);

    return {
      success: true,
      message: `Flow "${existing.name}" has been restored`,
    };
  }

  /**
   * List soft-deleted flows (trash)
   */
  async listDeleted(companyId: string): Promise<ConversationFlow[]> {
    return this.flowRepo.find({
      where: {
        companyId,
        deletedAt: Not(IsNull()),
      },
      order: { deletedAt: 'DESC' },
      withDeleted: true,
    });
  }

  /**
   * Permanently delete a flow (hard delete)
   */
  async hardDelete(
    flowId: string,
    companyId: string,
  ): Promise<{ success: boolean; message: string }> {
    const existing = await this.flowRepo.findOne({
      where: { id: flowId, companyId },
      withDeleted: true,
    });

    if (!existing) {
      throw new NotFoundException('Flow not found');
    }

    await this.flowRepo.remove(existing);

    return {
      success: true,
      message: `Flow "${existing.name}" has been permanently deleted`,
    };
  }

  /**
   * Track flow usage when a call is made using this conversation flow (e.g. outbound with flowId).
   * Same semantics as {@link CallScriptService.trackUsage}: increments totals and lastUsedAt.
   */
  async trackUsage(flowId: string, success = true): Promise<void> {
    try {
      const flow = await this.flowRepo.findOne({
        where: { id: flowId, deletedAt: IsNull() },
      });
      if (!flow) {
        this.logger.warn(`trackUsage: conversation flow not found: ${flowId}`);
        return;
      }

      flow.totalCalls = flow.totalCalls + 1;
      if (success) {
        flow.successfulCalls = flow.successfulCalls + 1;
      } else {
        flow.failedCalls = flow.failedCalls + 1;
      }
      flow.lastUsedAt = new Date();

      await this.flowRepo.save(flow);

      this.logger.log(
        `Tracked usage for flow: ${flow.name} (${flowId}) - Total: ${String(flow.totalCalls)}`,
      );
    } catch (error) {
      this.logger.error(`Failed to track usage for flow ${flowId}:`, error);
    }
  }

  async validateFlow(
    flowId: string,
    companyId: string,
  ): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
    details: {
      startNode: string | null;
      totalNodes: number;
      reachableNodes: number;
      unreachableNodes: string[];
      deadEnds: string[];
      missingIntents: string[];
      invalidTransitions: string[];
    };
  }> {
    const flow = await this.flowRepo.findOne({
      where: { id: flowId, companyId, deletedAt: IsNull() },
    });

    if (!flow) {
      throw new NotFoundException('Flow not found or has been deleted');
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const flowData: ConversationFlowJSON = getEffectiveFlow(flow.flow);

    const startNodeId = getStartNodeId(flowData);
    const nodesMap = getNodesMap(flowData);
    const nodeIds = Object.keys(nodesMap);

    if (!startNodeId) {
      errors.push('Missing "start_node_id" / "start" node identifier');
    } else if (!getNode(flowData, startNodeId)) {
      errors.push(`Start node "${startNodeId}" does not exist in nodes`);
    }

    if (nodeIds.length === 0) {
      errors.push('No nodes defined in flow');
      return {
        valid: false,
        errors,
        warnings: [],
        details: {
          startNode: startNodeId || null,
          totalNodes: 0,
          reachableNodes: 0,
          unreachableNodes: [],
          deadEnds: [],
          missingIntents: [],
          invalidTransitions: [],
        },
      };
    }

    const reachableNodes = new Set<string>();
    const deadEnds: string[] = [];
    const invalidTransitions: string[] = [];
    const missingIntents: string[] = [];

    if (startNodeId && getNode(flowData, startNodeId)) {
      const queue: string[] = [startNodeId];
      reachableNodes.add(startNodeId);

      while (queue.length > 0) {
        const currentId = queue.shift();
        if (currentId === undefined) break;
        const node = getNode(flowData, currentId);
        if (!node) continue;

        const listen = getListen(node);
        const transitions = getTransitions(node);
        const hasListen = Boolean(listen);
        const hasTransitions = Boolean(transitions?.length);
        const nodeIsEnd = isEndNode(node);
        const nodeIsTransfer = isTransferCallNode(node);
        const hasTool = 'tool' in node && node.tool != null;

        if (!hasListen && !hasTransitions && !nodeIsEnd && !nodeIsTransfer && !hasTool) {
          deadEnds.push(currentId);
          warnings.push(
            `Node "${currentId}" appears to be a dead end (no transitions, listen, tool, transfer, or end marker)`,
          );
        }

        if (
          nodeIsTransfer &&
          !getTransferDialTo(node) &&
          !getTransferFlowId(node) &&
          !getTransferAgentId(node)
        ) {
          errors.push(
            `Node "${currentId}" is a transfer_call node but has no destination configured`,
          );
        }

        if (transitions) {
          for (const transition of transitions) {
            if ('to' in transition && !('on_intent' in transition)) {
              const targetId = transition.to;
              if (!getNode(flowData, targetId)) {
                invalidTransitions.push(`${currentId} -> ${targetId} (target not found)`);
                errors.push(
                  `Invalid transition from "${currentId}" to non-existent node "${targetId}"`,
                );
              } else if (!reachableNodes.has(targetId)) {
                reachableNodes.add(targetId);
                queue.push(targetId);
              }
            }
            if ('on_intent' in transition && 'to' in transition) {
              const { on_intent, to } = transition;
              const intents = getIntents(flowData);
              if (intents && !(on_intent in intents)) {
                missingIntents.push(`"${on_intent}" (referenced in ${currentId})`);
                warnings.push(
                  `Intent "${on_intent}" used in node "${currentId}" is not defined in intents`,
                );
              }
              if (!getNode(flowData, to)) {
                invalidTransitions.push(
                  `${currentId} -> ${to} (intent: ${on_intent}, target not found)`,
                );
                errors.push(
                  `Invalid transition from "${currentId}" to non-existent node "${to}" (intent: ${on_intent})`,
                );
              } else if (!reachableNodes.has(to)) {
                reachableNodes.add(to);
                queue.push(to);
              }
            }
          }
        }

        if (listen?.fallback && getNode(flowData, listen.fallback)) {
          if (!reachableNodes.has(listen.fallback)) {
            reachableNodes.add(listen.fallback);
            queue.push(listen.fallback);
          }
        }
        if (listen?.next && getNode(flowData, listen.next)) {
          if (!reachableNodes.has(listen.next)) {
            reachableNodes.add(listen.next);
            queue.push(listen.next);
          }
        }
      }
    }

    const unreachableNodes = nodeIds.filter(id => !reachableNodes.has(id));
    if (unreachableNodes.length > 0) {
      warnings.push(`Unreachable nodes detected: ${unreachableNodes.join(', ')}`);
    }

    const transferFlowTargets: { nodeId: string; flowId: string }[] = [];
    const transferAgentTargets: { nodeId: string; agentId: string }[] = [];

    for (const nodeId of nodeIds) {
      const node = getNode(flowData, nodeId);
      if (!node) continue;

      if (getSayTemplate(node)) {
        // template vars validation optional
      }

      const transferFlowId = getTransferFlowId(node);
      if (transferFlowId) {
        if (transferFlowId === flowId) {
          errors.push(`Node "${nodeId}" transfers to itself — pick a different target flow`);
        } else {
          transferFlowTargets.push({ nodeId, flowId: transferFlowId });
        }
      }

      const transferAgentId = getTransferAgentId(node);
      if (transferAgentId) {
        transferAgentTargets.push({ nodeId, agentId: transferAgentId });
      }

      const listen = getListen(node);
      if (listen) {
        if (listen.capture_slot && !/^[a-zA-Z0-9_]+$/.test(listen.capture_slot)) {
          warnings.push(`Node "${nodeId}" has invalid capture_slot name "${listen.capture_slot}"`);
        }
        const intents = getIntents(flowData);
        if (listen.intent_scope?.length && intents) {
          for (const intent of listen.intent_scope) {
            if (!(intent in intents)) {
              missingIntents.push(`"${intent}" (in scope of ${nodeId})`);
              warnings.push(`Intent "${intent}" in scope of "${nodeId}" is not defined`);
            }
          }
        }
      }

      const tool = 'tool' in node && node.tool != null ? node.tool : undefined;
      if (tool) {
        if (!tool.name) {
          errors.push(`Node "${nodeId}" has tool without a name`);
        }
        if (
          flowData.tools &&
          !flowData.tools.find((t: ElevenLabsToolDefinition) => t.name === tool.name)
        ) {
          warnings.push(`Tool "${tool.name}" used in node "${nodeId}" is not defined in tools`);
        }
      }

      const position = getPosition(node);
      if (position) {
        if (typeof position.x !== 'number' || typeof position.y !== 'number') {
          errors.push(`Node "${nodeId}" has invalid position: x and y must be numbers`);
        } else {
          const MAX_POSITION = 10000;
          const MIN_POSITION = -10000;
          if (
            position.x > MAX_POSITION ||
            position.x < MIN_POSITION ||
            position.y > MAX_POSITION ||
            position.y < MIN_POSITION
          ) {
            warnings.push(
              `Node "${nodeId}" has position outside recommended bounds (${String(MIN_POSITION)} to ${String(MAX_POSITION)})`,
            );
          }
        }
      }
    }

    if (transferFlowTargets.length > 0) {
      const targetIds = [...new Set(transferFlowTargets.map(t => t.flowId))];
      const targetFlows = await this.flowRepo.find({
        where: { id: In(targetIds), companyId, deletedAt: IsNull() },
      });
      const byId = new Map(targetFlows.map(f => [f.id, f]));
      for (const { nodeId, flowId: targetId } of transferFlowTargets) {
        const target = byId.get(targetId);
        if (!target) {
          errors.push(
            `Node "${nodeId}" transfers to flow "${targetId}" which does not exist in this company`,
          );
        } else if (target.status !== 'published') {
          warnings.push(
            `Node "${nodeId}" transfers to flow "${target.name}" which is not published yet — the transfer will fail until it is`,
          );
        }
      }
    }

    if (transferAgentTargets.length > 0) {
      const targetIds = [...new Set(transferAgentTargets.map(t => t.agentId))];
      const targetAgents = await this.agentsService.findByIds(targetIds, companyId);
      const byId = new Map(targetAgents.map(a => [a.id, a]));
      for (const { nodeId, agentId: targetId } of transferAgentTargets) {
        const target = byId.get(targetId);
        if (!target) {
          errors.push(
            `Node "${nodeId}" transfers to agent "${targetId}" which does not exist in this company`,
          );
        } else if (!target.isPublished) {
          warnings.push(
            `Node "${nodeId}" transfers to agent "${target.agentName}" which is not published yet — the transfer will fail until it is`,
          );
        } else if (
          !isConversationFlowEngine(target.responseEngine) ||
          !target.responseEngine.conversation_flow_id
        ) {
          errors.push(
            `Node "${nodeId}" transfers to agent "${target.agentName}" which is not a conversation-flow agent — only flow-based agents can be transfer targets today`,
          );
        }
      }
    }

    // Validate tools definitions if present
    if (flowData.tools) {
      for (const tool of flowData.tools) {
        if (!tool.name) {
          errors.push('Tool missing name property');
        }
        if (!tool.description) {
          warnings.push(`Tool "${tool.name || 'unknown'}" missing description`);
        }
        const paramType = (tool.parameters as { type?: unknown }).type;
        if (paramType !== 'object') {
          warnings.push(`Tool "${tool.name || 'unknown'}" has invalid parameters structure`);
        }
        if (tool.returns != null) {
          const ret = tool.returns as { type?: unknown; properties?: unknown };
          if (ret.type !== 'object') {
            warnings.push(
              `Tool "${tool.name || 'unknown'}" returns must use type: "object" (JSON Schema style)`,
            );
          }
          if (ret.properties != null && typeof ret.properties !== 'object') {
            warnings.push(`Tool "${tool.name || 'unknown'}" returns.properties must be an object`);
          }
        }
      }
    }

    // Deduplicate
    const uniqueMissingIntents = [...new Set(missingIntents)];
    const uniqueInvalidTransitions = [...new Set(invalidTransitions)];

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      details: {
        startNode: startNodeId || null,
        totalNodes: nodeIds.length,
        reachableNodes: reachableNodes.size,
        unreachableNodes,
        deadEnds: [...new Set(deadEnds)],
        missingIntents: uniqueMissingIntents,
        invalidTransitions: uniqueInvalidTransitions,
      },
    };
  }
}
