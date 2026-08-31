import { Injectable, Logger } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';

import { AgentsService } from '../agents/agents.service';
import { CallScriptService } from '../call-scripts/call-script.service';
import type { DashboardPerformanceFilters } from './dto/dashboard-performance-filters.dto';
import {
  AgentPerformanceDto,
  AgentPerformanceReportDto,
  CallActivityDto,
  CallVolumeDto,
  DashboardOverviewDto,
  FlowPerformanceReportDto,
  PerformanceUsageBucketDto,
  PerformanceUsageSeriesDto,
  ResourceCallVolumeDto,
  ResourceVolumeBucket,
  ScriptPerformanceReportDto,
  TimeSeriesDataPoint,
  TopScriptsDto,
} from './dto/dashboard-overview.dto';
import {
  ElevenLabsCreditsHealthDto,
  ProviderCreditsHealthDto,
  TelnyxCreditsHealthDto,
  TwilioCreditsHealthDto,
} from './dto/provider-credits.dto';
import { TwilioClient } from '../clients/twilio/twilio.client';
import { CallRecordService } from '../calls/services/call-record.service';
import { CallStateService } from '../calls/services/call-state.service';
import elevenlabsConfig from '../configs/elevenlabs.config';
import { FlowsService } from '../flows/flows.service';
import { Agent } from '../models/agents/agent.entity';
import { CallScript } from '../models/call-scripts/call-script.entity';
import { CallRecord } from '../models/calls/call-record.entity';
import { ConversationFlow } from '../models/conversation-flows/conversation-flows.entity';
import { TelnyxClient } from '../clients/telnyx/telnyx.client';

/** Get flowId from call record metadata (JSON). Returns flowId only when metadata has flowId. */
function getFlowIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const id = metadata.flowId;
  return typeof id === 'string' ? id : undefined;
}

function getAgentIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const id = metadata.agentId;
  return typeof id === 'string' ? id : undefined;
}

/** Primary template attribution: agent → flow → script column → other. */
function classifyCallResource(call: CallRecord): 'agent' | 'conversationFlow' | 'script' | 'other' {
  const meta = call.metadata as Record<string, unknown> | null | undefined;
  if (getAgentIdFromMetadata(meta)) return 'agent';
  if (getFlowIdFromMetadata(meta)) return 'conversationFlow';
  if (call.scriptId) return 'script';
  return 'other';
}

function agentEngineType(agent: Agent): AgentPerformanceDto['responseEngineType'] {
  switch (agent.responseEngine.type) {
    case 'conversation-flow':
    case 'script':
    case 'llm':
      return agent.responseEngine.type;
    default:
      return 'unknown';
  }
}

function narrowCallType(t: string | undefined): 'inbound' | 'outbound' | 'both' {
  if (t === 'inbound' || t === 'outbound' || t === 'both') return t;
  return 'both';
}

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function parseOptionalIsoDate(s: string | undefined): Date | undefined {
  if (s == null || String(s).trim() === '') return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Bucket counts aligned with GET .../calls/volume/by-resource */
function volumePeriodSpec(period: 'hour' | 'day' | 'week' | 'month'): {
  rangeMs: number;
  bucketMs: number;
  bucketCount: number;
} {
  switch (period) {
    case 'hour':
      return {
        rangeMs: 60 * 60 * 1000,
        bucketMs: 5 * 60 * 1000,
        bucketCount: 12,
      };
    case 'day':
      return {
        rangeMs: 24 * 60 * 60 * 1000,
        bucketMs: 60 * 60 * 1000,
        bucketCount: 24,
      };
    case 'week':
      return {
        rangeMs: 7 * 24 * 60 * 60 * 1000,
        bucketMs: 24 * 60 * 60 * 1000,
        bucketCount: 7,
      };
    case 'month':
      return {
        rangeMs: 30 * 24 * 60 * 60 * 1000,
        bucketMs: 24 * 60 * 60 * 1000,
        bucketCount: 30,
      };
  }
}

/**
 * Effective time window + bucket layout for performance reports.
 * With no filters, defaults to last 24 hours (`day`-style buckets).
 */
function resolvePerformanceReportWindow(filters?: DashboardPerformanceFilters): {
  windowStart: Date;
  windowEnd: Date;
  layoutPeriod: 'hour' | 'day' | 'week' | 'month';
} {
  const layoutPeriod = filters?.period ?? 'day';
  const spec = volumePeriodSpec(layoutPeriod);
  const now = new Date();
  const explicitFrom = parseOptionalIsoDate(filters?.from);
  const explicitTo = parseOptionalIsoDate(filters?.to);

  if (explicitFrom != null || explicitTo != null) {
    const windowEnd = explicitTo ?? now;
    const windowStart = explicitFrom ?? new Date(windowEnd.getTime() - spec.rangeMs);
    return { windowStart, windowEnd, layoutPeriod };
  }

  if (filters?.period) {
    const pSpec = volumePeriodSpec(filters.period);
    return {
      windowStart: new Date(now.getTime() - pSpec.rangeMs),
      windowEnd: now,
      layoutPeriod: filters.period,
    };
  }

  const daySpec = volumePeriodSpec('day');
  return {
    windowStart: new Date(now.getTime() - daySpec.rangeMs),
    windowEnd: now,
    layoutPeriod: 'day',
  };
}

function buildPerformanceUsageSeries(
  calls: CallRecord[],
  windowStart: Date,
  windowEnd: Date,
  layoutPeriod: 'hour' | 'day' | 'week' | 'month',
): PerformanceUsageSeriesDto {
  const spec = volumePeriodSpec(layoutPeriod);
  const windowMs = Math.max(1, windowEnd.getTime() - windowStart.getTime());
  const bucketCount = spec.bucketCount;
  const bucketMs = windowMs / bucketCount;

  const data: PerformanceUsageBucketDto[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    data.push({
      // Anchor timestamps at window end like `getResourceCallVolume`
      timestamp: new Date(windowEnd.getTime() - i * bucketMs),
      total: 0,
      completed: 0,
      failed: 0,
      active: 0,
      retried: 0,
    });
  }

  const totals = { total: 0, completed: 0, failed: 0, active: 0, retried: 0 };

  for (const call of calls) {
    const created = call.createdAt;
    if (!created) continue;
    const t = created.getTime();
    if (t > windowEnd.getTime()) continue;

    const age = windowEnd.getTime() - t;
    if (age > windowMs) continue;
    const bucketIndex = Math.floor(age / bucketMs);
    const idx = bucketCount - 1 - bucketIndex;
    if (idx < 0 || idx >= data.length) continue;

    const b = data[idx];
    if (!b) continue;

    b.total += 1;
    totals.total += 1;
    const st = call.status;
    if (st === 'completed') {
      b.completed += 1;
      totals.completed += 1;
    } else if (st === 'failed' || st === 'cancelled') {
      b.failed += 1;
      totals.failed += 1;
    } else if (st === 'retried') {
      b.retried += 1;
      totals.retried += 1;
    } else if (st === 'active' || st === 'initiating') {
      b.active += 1;
      totals.active += 1;
    } else {
      b.active += 1;
      totals.active += 1;
    }
  }

  let peak = { timestamp: windowStart, count: 0 };
  for (const b of data) {
    if (b.total > peak.count) peak = { timestamp: b.timestamp, count: b.total };
  }

  return {
    period: layoutPeriod,
    window: { from: windowStart, to: windowEnd },
    data,
    totals,
    peak,
  };
}

function extractInboundInsight(metadata: Record<string, unknown> | null | undefined): {
  category: string;
  purpose: string;
  summary: string;
} | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata.inboundInsight;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const category = typeof o.category === 'string' ? o.category : '';
  const purpose = typeof o.purpose === 'string' ? o.purpose : '';
  const summary = typeof o.summary === 'string' ? o.summary : '';
  if (!category && !purpose && !summary) return null;
  return { category, purpose, summary };
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly callStateService: CallStateService,
    private readonly callScriptService: CallScriptService,
    private readonly callRecordService: CallRecordService,
    private readonly flowsService: FlowsService,
    private readonly agentsService: AgentsService,
    private readonly configService: ConfigService,
    private readonly twilioClient: TwilioClient,
    private readonly telnyxClient: TelnyxClient,
  ) {}

  /**
   * Get comprehensive dashboard overview (By Company )
   */
  async getOverview(
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<DashboardOverviewDto> {
    try {
      const dbCallStats = await this.callRecordService.getStats(companyId, period);
      // const memoryCallStats = this.callStateService.getStats(companyId, period);
      const scriptStats = await this.callScriptService.getStats(companyId, period);
      const flowInventory = await this.flowsService.getStats(companyId, period);
      const flowUsage = await this.flowsService.getUsageTotals(companyId, period);
      const agentInventory = await this.agentsService.getStats(companyId ?? null, period);

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const callsLast24h = await this.callRecordService.findSince(since24h, companyId);
      const last24HoursByResource = {
        agent: 0,
        conversationFlow: 0,
        script: 0,
        other: 0,
      };
      for (const call of callsLast24h) {
        const key = classifyCallResource(call);
        last24HoursByResource[key]++;
      }

      // const completedCalls = dbCallStats.byStatus.completed || 0;
      // const failedCalls =
      //   dbCallStats.byStatus.failed ||
      //   dbCallStats.byStatus.cancelled ||
      //   dbCallStats.byStatus.retried ||
      //   0;
      // const totalFinished = completedCalls + failedCalls;
      // const successRate = totalFinished > 0 ? (completedCalls / totalFinished) * 100 : 0;
      const completedCalls = dbCallStats.byStatus.completed || 0;

      const failedCalls =
        (dbCallStats.byStatus.failed || 0) +
        (dbCallStats.byStatus.cancelled || 0) +
        (dbCallStats.byStatus.retried || 0);

      const totalFinished = completedCalls + failedCalls;

      const successRate = totalFinished > 0 ? (completedCalls / totalFinished) * 100 : 0;

      return {
        summary: {
          totalCalls: dbCallStats.total,
          // activeCalls: memoryCallStats.byStatus.active || 0,
          activeCalls: dbCallStats.byStatus.active || 0,
          totalScripts: scriptStats.total,
          activeScripts: scriptStats.active,
          totalFlows: flowInventory.total,
          publishedFlows: flowInventory.published,
          totalAgents: agentInventory.total,
          publishedAgents: agentInventory.published,
        },
        callStats: {
          total: dbCallStats.total,
          byStatus: {
            initiating: dbCallStats.byStatus.initiating || 0,
            // active: memoryCallStats.byStatus.active || dbCallStats.byStatus.active || 0,
            active: dbCallStats.byStatus.active || 0,
            completed: completedCalls,
            failed: dbCallStats.byStatus.failed + (dbCallStats.byStatus.cancelled || 0) || 0,
            retried: dbCallStats.byStatus.retried || 0,
          },
          successRate: Math.round(successRate * 100) / 100,
        },
        scriptStats,
        flowStats: {
          total: flowInventory.total,
          published: flowInventory.published,
          draft: flowInventory.draft,
          archived: flowInventory.archived,
          totalCallsOnFlows: flowUsage.totalCalls,
          successfulCallsOnFlows: flowUsage.successfulCalls,
          failedCallsOnFlows: flowUsage.failedCalls,
        },
        agentStats: {
          total: agentInventory.total,
          published: agentInventory.published,
          unpublished: agentInventory.unpublished,
          byChannel: agentInventory.byChannel,
        },
        recentActivity: {
          last24Hours: dbCallStats.last24Hours,
          lastHour: dbCallStats.lastHour,
          last24HoursByResource,
        },
      };
    } catch (error) {
      this.logger.error('Error getting dashboard overview:', error);
      throw error;
    }
  }

  /**
   * Get detailed script performance metrics ( By Company )
   */
  async getScriptPerformance(
    companyId?: string,
    filters?: DashboardPerformanceFilters,
  ): Promise<ScriptPerformanceReportDto> {
    try {
      const { windowStart, windowEnd, layoutPeriod } = resolvePerformanceReportWindow(filters);

      let scripts: CallScript[];
      if (companyId) {
        scripts = await this.callScriptService.findAll(companyId);
      } else {
        scripts = await this.callScriptService.findAll();
      }

      if (filters?.scriptId) {
        scripts = scripts.filter(s => s.id === filters.scriptId);
      }

      const rows = await this.callRecordService.findAttributionRows(companyId, {
        from: windowStart,
        to: windowEnd,
      });

      const seriesCalls = rows.filter(c => {
        if (getAgentIdFromMetadata(c.metadata as Record<string, unknown> | null | undefined))
          return false;
        if (!c.scriptId) return false;
        if (filters?.scriptId && c.scriptId !== filters.scriptId) return false;
        return true;
      });
      const usageSeries = buildPerformanceUsageSeries(
        seriesCalls,
        windowStart,
        windowEnd,
        layoutPeriod,
      );

      const usage = new Map<
        string,
        { total: number; ok: number; fail: number; active: number; retried: number }
      >();

      for (const call of rows) {
        if (!call.scriptId) continue;
        if (filters?.scriptId && call.scriptId !== filters.scriptId) continue;
        const cur = usage.get(call.scriptId) ?? { total: 0, ok: 0, fail: 0, active: 0, retried: 0 };
        cur.total += 1;
        if (call.status === 'completed') cur.ok += 1;
        else if (call.status === 'failed' || call.status === 'cancelled') cur.fail += 1;
        else if (call.status === 'retried') cur.retried += 1;
        else if (call.status === 'active' || call.status === 'initiating') cur.active += 1;
        usage.set(call.scriptId, cur);
      }

      const scriptDtos = scripts.map(script => {
        const u = usage.get(script.id) ?? { total: 0, ok: 0, fail: 0, active: 0, retried: 0 };
        const successRate = u.total > 0 ? (u.ok / u.total) * 100 : 0;
        return {
          id: script.id,
          name: script.name,
          callType: narrowCallType(script.callType),
          totalCalls: u.total,
          successfulCalls: u.ok,
          failedCalls: u.fail,
          activeCalls: u.active,
          retriedCalls: u.retried,
          successRate: Math.round(successRate * 100) / 100,
          lastUsedAt: script.lastUsedAt,
          isActive: script.isActive,
          isDefault: script.isDefault,
        };
      });

      return { scripts: scriptDtos, usage: usageSeries };
    } catch (error) {
      this.logger.error('Error getting script performance:', error);
      throw error;
    }
  }

  /**
   * Per-flow performance using counters on conversation_flows (same idea as scripts).
   */
  async getFlowPerformance(
    companyId?: string,
    filters?: DashboardPerformanceFilters,
  ): Promise<FlowPerformanceReportDto> {
    try {
      const { windowStart, windowEnd, layoutPeriod } = resolvePerformanceReportWindow(filters);

      let flows = await this.flowsService.listEvery(companyId);
      if (filters?.flowId) {
        flows = flows.filter(f => f.id === filters.flowId);
      }

      const rows = await this.callRecordService.findAttributionRows(companyId, {
        from: windowStart,
        to: windowEnd,
      });

      const seriesCalls = rows.filter(c => {
        const fid = getFlowIdFromMetadata(c.metadata as Record<string, unknown> | null | undefined);
        const agentId = getAgentIdFromMetadata(
          c.metadata as Record<string, unknown> | null | undefined,
        );
        if (!fid) return false;
        if (filters?.flowId && fid !== filters.flowId) return false;
        return !agentId;
      });
      const usageSeries = buildPerformanceUsageSeries(
        seriesCalls,
        windowStart,
        windowEnd,
        layoutPeriod,
      );

      const usage = new Map<
        string,
        { total: number; ok: number; fail: number; active: number; retried: number }
      >();

      for (const call of rows) {
        const fid = getFlowIdFromMetadata(
          call.metadata as Record<string, unknown> | null | undefined,
        );
        if (!fid) continue;
        if (filters?.flowId && fid !== filters.flowId) continue;
        const cur = usage.get(fid) ?? { total: 0, ok: 0, fail: 0, active: 0, retried: 0 };
        cur.total += 1;
        if (call.status === 'completed') cur.ok += 1;
        else if (call.status === 'failed' || call.status === 'cancelled') cur.fail += 1;
        else if (call.status === 'retried') cur.retried += 1;
        else if (call.status === 'active' || call.status === 'initiating') cur.active += 1;
        usage.set(fid, cur);
      }

      const flowDtos = flows.map(flow => {
        const u = usage.get(flow.id) ?? { total: 0, ok: 0, fail: 0, active: 0, retried: 0 };
        const successRate = u.total > 0 ? (u.ok / u.total) * 100 : 0;
        return {
          id: flow.id,
          name: flow.name,
          status: flow.status,
          scriptId: flow.scriptId,
          totalCalls: u.total,
          successfulCalls: u.ok,
          failedCalls: u.fail,
          activeCalls: u.active,
          retriedCalls: u.retried,
          successRate: Math.round(successRate * 100) / 100,
          lastUsedAt: flow.lastUsedAt,
        };
      });

      return { flows: flowDtos, usage: usageSeries };
    } catch (error) {
      this.logger.error('Error getting flow performance:', error);
      throw error;
    }
  }

  /**
   * Per-agent performance from call record metadata.agentId (completed vs failed/cancelled).
   */
  async getAgentPerformance(
    companyId?: string,
    filters?: DashboardPerformanceFilters,
  ): Promise<AgentPerformanceReportDto> {
    try {
      const { windowStart, windowEnd, layoutPeriod } = resolvePerformanceReportWindow(filters);

      let agents = await this.agentsService.findAll(companyId ?? null);
      if (filters?.agentId) {
        agents = agents.filter(a => a.id === filters.agentId);
      }

      const rows = await this.callRecordService.findAttributionRows(companyId, {
        from: windowStart,
        to: windowEnd,
      });

      const seriesCalls = rows.filter(c => {
        const aid = getAgentIdFromMetadata(
          c.metadata as Record<string, unknown> | null | undefined,
        );
        if (!aid) return false;
        if (filters?.agentId && aid !== filters.agentId) return false;
        return true;
      });
      const usageSeries = buildPerformanceUsageSeries(
        seriesCalls,
        windowStart,
        windowEnd,
        layoutPeriod,
      );

      const usage = new Map<
        string,
        { total: number; ok: number; fail: number; active: number; retried: number }
      >();

      for (const call of rows) {
        const aid = getAgentIdFromMetadata(
          call.metadata as Record<string, unknown> | null | undefined,
        );
        if (!aid) continue;
        if (filters?.agentId && aid !== filters.agentId) continue;
        const cur = usage.get(aid) ?? { total: 0, ok: 0, fail: 0, active: 0, retried: 0 };
        cur.total += 1;
        if (call.status === 'completed') cur.ok += 1;
        else if (call.status === 'failed' || call.status === 'cancelled') cur.fail += 1;
        else if (call.status === 'retried') cur.retried += 1;
        else if (call.status === 'active' || call.status === 'initiating') cur.active += 1;
        usage.set(aid, cur);
      }

      const agentDtos = agents.map(agent => {
        const u = usage.get(agent.id) ?? { total: 0, ok: 0, fail: 0, active: 0, retried: 0 };
        const successRate = u.total > 0 ? (u.ok / u.total) * 100 : 0;
        return {
          id: agent.id,
          agentName: agent.agentName,
          channel: agent.channel,
          isPublished: agent.isPublished,
          responseEngineType: agentEngineType(agent),
          totalCalls: u.total,
          successfulCalls: u.ok,
          failedCalls: u.fail,
          activeCalls: u.active,
          retriedCalls: u.retried,
          successRate: Math.round(successRate * 100) / 100,
        };
      });

      return { agents: agentDtos, usage: usageSeries };
    } catch (error) {
      this.logger.error('Error getting agent performance:', error);
      throw error;
    }
  }

  /**
   * Call volume over time split by primary resource (agent / flow / script / other).
   */
  async getResourceCallVolume(
    period: 'hour' | 'day' | 'week' | 'month' = 'day',
    companyId?: string,
  ): Promise<ResourceCallVolumeDto> {
    try {
      const now = new Date();
      const { rangeMs, bucketMs, bucketCount } = volumePeriodSpec(period);

      const since = new Date(now.getTime() - rangeMs);
      const calls = await this.callRecordService.findSince(since, companyId);

      const buckets: ResourceVolumeBucket[] = [];
      for (let i = bucketCount - 1; i >= 0; i--) {
        buckets.push({
          timestamp: new Date(now.getTime() - i * bucketMs),
          agent: 0,
          conversationFlow: 0,
          script: 0,
          other: 0,
        });
      }

      for (const call of calls) {
        const callTime = call.createdAt.getTime();
        const age = now.getTime() - callTime;
        if (age > rangeMs) continue;
        const bucketIndex = Math.floor(age / bucketMs);
        const actualIndex = bucketCount - 1 - bucketIndex;
        if (actualIndex < 0 || actualIndex >= buckets.length) continue;
        const kind = classifyCallResource(call);
        buckets[actualIndex][kind] += 1;
      }

      const totals = buckets.reduce(
        (acc, b) => ({
          agent: acc.agent + b.agent,
          conversationFlow: acc.conversationFlow + b.conversationFlow,
          script: acc.script + b.script,
          other: acc.other + b.other,
        }),
        { agent: 0, conversationFlow: 0, script: 0, other: 0 },
      );

      let peak = { timestamp: buckets[0]?.timestamp ?? now, count: 0 };
      for (const b of buckets) {
        const c = b.agent + b.conversationFlow + b.script + b.other;
        if (c > peak.count) peak = { timestamp: b.timestamp, count: c };
      }

      return { period, data: buckets, totals, peak };
    } catch (error) {
      this.logger.error('Error getting resource call volume:', error);
      throw error;
    }
  }

  /**
   * Get recent call activity from database (includes script and conversation flow data)
   */
  async getRecentActivity(
    limit = 20,
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<CallActivityDto[]> {
    try {
      // Get recent calls from database (persistent)
      let calls: CallRecord[];
      if (period) {
        const now = new Date();
        const periodMs = {
          hour: 60 * 60 * 1000,
          day: 24 * 60 * 60 * 1000,
          week: 7 * 24 * 60 * 60 * 1000,
          month: 30 * 24 * 60 * 60 * 1000,
        };
        const cutoff = new Date(now.getTime() - (periodMs[period] || periodMs.day));
        if (companyId) {
          calls = await this.callRecordService.findSince(cutoff, companyId);
        } else {
          calls = await this.callRecordService.findSince(cutoff);
        }
      } else {
        if (companyId) {
          calls = await this.callRecordService.findAll(limit, companyId);
        } else {
          calls = await this.callRecordService.findAll(limit);
        }
      }
      // if (companyId) {
      //   calls = await this.callRecordService.findAll(limit, companyId);
      // } else {
      //   calls = await this.callRecordService.findAll(limit);
      // }

      const flowIds = calls
        .map(c => getFlowIdFromMetadata(c.metadata as Record<string, unknown> | null | undefined))
        .filter((id): id is string => id != null);
      const agentIds = calls
        .map(c => getAgentIdFromMetadata(c.metadata as Record<string, unknown> | null | undefined))
        .filter((id): id is string => id != null);

      const flowsMap = new Map<string, { id: string; name: string }>();
      if (flowIds.length > 0) {
        const resolvedFlows = await this.flowsService.findByIds(flowIds, true);
        resolvedFlows.forEach(f => flowsMap.set(f.id, { id: f.id, name: f.name }));
      }

      const agentsMap = new Map<string, { id: string; name: string }>();
      if (agentIds.length > 0) {
        const resolvedAgents = await this.agentsService.findByIds(agentIds, companyId ?? null);
        resolvedAgents.forEach(a => agentsMap.set(a.id, { id: a.id, name: a.agentName }));
      }

      this.logger.debug(
        `[getRecentActivity] calls=${String(calls.length)} flowsResolved=${String(flowsMap.size)} agentsResolved=${String(agentsMap.size)}`,
      );

      return calls.map(call => {
        const scriptUsed = call.scriptId
          ? { id: call.scriptId, name: call.scriptName ?? 'Unknown' }
          : null;
        const flowId = getFlowIdFromMetadata(
          call.metadata as Record<string, unknown> | null | undefined,
        );
        const flowResolved = flowId != null ? flowsMap.get(flowId) : undefined;
        const flowUsed =
          flowResolved != null ? { id: flowResolved.id, name: flowResolved.name } : null;
        const agentId = getAgentIdFromMetadata(
          call.metadata as Record<string, unknown> | null | undefined,
        );
        const agentResolved = agentId != null ? agentsMap.get(agentId) : undefined;
        const agentUsed =
          agentResolved != null ? { id: agentResolved.id, name: agentResolved.name } : null;

        const inboundInsight = extractInboundInsight(
          call.metadata as Record<string, unknown> | null | undefined,
        );

        const template = agentUsed
          ? 'agent'
          : flowUsed
            ? 'conversation flow'
            : scriptUsed
              ? 'script'
              : 'custom script';

        return {
          callSid: call.callSid,
          status: call.status,
          phoneNumberFrom: call.phoneNumberFrom,
          phoneNumberTo: call.phoneNumberTo,
          template,
          createdAt: call.createdAt,
          updatedAt: call.updatedAt,
          duration: call.duration ?? undefined,
          scriptUsed,
          flowUsed,
          agentUsed,
          ...(flowId != null && flowUsed == null ? { flowIdFromMetadata: flowId } : {}),
          ...(inboundInsight != null ? { inboundInsight } : {}),
        };
      });
    } catch (error) {
      this.logger.error('Error getting recent activity:', error);
      throw error;
    }
  }

  /**
   * Get call volume over time from database
   */
  async getCallVolume(
    period: 'hour' | 'day' | 'week' | 'month' = 'day',
    companyId?: string,
  ): Promise<CallVolumeDto> {
    try {
      const now = new Date();

      let rangeMs: number;
      let bucketMs: number;
      let bucketCount: number;

      switch (period) {
        case 'hour':
          rangeMs = 60 * 60 * 1000;
          bucketMs = 5 * 60 * 1000;
          bucketCount = 12;
          break;
        case 'day':
          rangeMs = 24 * 60 * 60 * 1000;
          bucketMs = 60 * 60 * 1000;
          bucketCount = 24;
          break;
        case 'week':
          rangeMs = 7 * 24 * 60 * 60 * 1000;
          bucketMs = 24 * 60 * 60 * 1000;
          bucketCount = 7;
          break;
        case 'month':
          rangeMs = 30 * 24 * 60 * 60 * 1000;
          bucketMs = 24 * 60 * 60 * 1000;
          bucketCount = 30;
          break;
      }

      const since = new Date(now.getTime() - rangeMs);
      const calls = await this.callRecordService.findSince(since, companyId);

      // Initialize buckets
      const buckets: TimeSeriesDataPoint[] = [];
      for (let i = bucketCount - 1; i >= 0; i--) {
        buckets.push({
          timestamp: new Date(now.getTime() - i * bucketMs),
          count: 0,
        });
      }

      // Fill buckets with call counts
      calls.forEach(call => {
        const callTime = call.createdAt.getTime();
        const age = now.getTime() - callTime;

        if (age <= rangeMs) {
          const bucketIndex = Math.floor(age / bucketMs);
          const actualIndex = bucketCount - 1 - bucketIndex;

          if (actualIndex >= 0 && actualIndex < buckets.length) {
            buckets[actualIndex].count++;
          }
        }
      });

      // Find peak
      const peak = buckets.reduce(
        (max, bucket) => {
          return bucket.count > max.count ? bucket : max;
        },
        { timestamp: buckets[0].timestamp, count: 0 },
      );

      return {
        period,
        data: buckets,
        total: buckets.reduce((sum, b) => sum + b.count, 0),
        peak,
      };
    } catch (error) {
      this.logger.error('Error getting call volume:', error);
      throw error;
    }
  }

  /**
   * Get top performing scripts (includes linked conversation flows and agents if possible) sorted by total calls.
   */
  async getTopScripts(
    limit = 5,
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<TopScriptsDto> {
    try {
      let scripts: CallScript[];
      let flows: ConversationFlow[];
      let agents: Agent[];
      // if (period) {
      //   const now = new Date();
      //   const periodMs = {
      //     hour: 60 * 60 * 1000,
      //     day: 24 * 60 * 60 * 1000,
      //     week: 7 * 24 * 60 * 60 * 1000,
      //     month: 30 * 24 * 60 * 60 * 1000,
      //   };
      //   const cutoff = new Date(now.getTime() - (periodMs[period] || periodMs.day));
      //   if (companyId) {
      //     scripts = await this.callScriptService.findAllSince(cutoff, companyId);
      //     flows = await this.flowsService.listSince(cutoff, companyId);
      //     agents = await this.agentsService.findAllSince(cutoff, companyId);
      //   } else {
      //     scripts = await this.callScriptService.findAllSince(cutoff);
      //     flows = await this.flowsService.listAllSince(cutoff);
      //     agents = await this.agentsService.findAllSince(cutoff);
      //   }
      // } else {
      if (companyId) {
        scripts = await this.callScriptService.findAll(companyId);
        flows = await this.flowsService.list(companyId);
        agents = await this.agentsService.findAll(companyId);
      } else {
        scripts = await this.callScriptService.findAll();
        flows = await this.flowsService.listAll();
        agents = await this.agentsService.findAll();
      }
      // }

      // Filter and sort by total calls after merging with flow usage data with type as well like conversation flow or script
      const scriptUsageMap = new Map<
        string,
        {
          id: string;
          name: string;
          callType?: 'inbound' | 'outbound' | 'both';
          totalCalls: number;
          successfulCalls: number;
          template: string;
        }
      >();

      scripts.forEach(script => {
        scriptUsageMap.set(script.id, {
          id: script.id,
          name: script.name,
          callType: script.callType,
          totalCalls: script.totalCalls,
          successfulCalls: script.successfulCalls,
          template: 'script',
        });
      });

      flows.forEach(flow => {
        scriptUsageMap.set(flow.id, {
          id: flow.id,
          name: flow.name,
          callType: 'both',
          totalCalls: flow.totalCalls,
          successfulCalls: flow.successfulCalls,
          template: 'conversation flow',
        });
      });

      // calculate agent usage from call record metadata and merge into the map with type agent
      let rows: CallRecord[];
      if (period) {
        rows = await this.callRecordService.findAttributionRows(companyId, {
          from: new Date(
            Date.now() -
              {
                hour: 60 * 60 * 1000,
                day: 24 * 60 * 60 * 1000,
                week: 7 * 24 * 60 * 60 * 1000,
                month: 30 * 24 * 60 * 60 * 1000,
              }[period] || 24 * 60 * 60 * 1000,
          ),
          to: new Date(),
        });
      } else {
        rows = await this.callRecordService.findAttributionRows(companyId);
      }
      // const rows = await this.callRecordService.findAttributionRows(companyId);
      const agentUsage = new Map<string, { total: number; successful: number }>();

      for (const call of rows) {
        const aid = getAgentIdFromMetadata(
          call.metadata as Record<string, unknown> | null | undefined,
        );
        if (!aid) continue;
        const cur = agentUsage.get(aid) ?? { total: 0, successful: 0 };
        cur.total += 1;
        if (call.status === 'completed') cur.successful += 1;
        agentUsage.set(aid, cur);
      }

      agents.forEach(agent => {
        const usage = agentUsage.get(agent.id);
        if (usage) {
          scriptUsageMap.set(agent.id, {
            id: agent.id,
            name: agent.agentName,
            callType: 'both',
            totalCalls: usage.total,
            successfulCalls: usage.successful,
            template: 'agent',
          });
        }
      });

      const templatesWithUsage = Array.from(scriptUsageMap.values());

      const sortedScripts = templatesWithUsage
        .filter(s => s.totalCalls > 0)
        .sort((a, b) => b.totalCalls - a.totalCalls)
        .slice(0, limit);
      this.logger.debug(
        `[getTopScripts] scripts=${String(scripts.length)} flows=${String(flows.length)} agents=${String(agents.length)} returning=${String(sortedScripts.length)}`,
      );
      const scriptIds = sortedScripts.map(s => s.id);
      const flowsByScript = new Map<string, { id: string; name: string; status: string }[]>();
      if (scriptIds.length > 0) {
        const flows = await this.flowsService.findFlowsByScriptIds(scriptIds, companyId);
        flows.forEach(f => {
          if (f.scriptId) {
            const list = flowsByScript.get(f.scriptId) ?? [];
            list.push({ id: f.id, name: f.name, status: f.status });
            flowsByScript.set(f.scriptId, list);
          }
        });
      }

      return {
        templates: sortedScripts.map(script => {
          const successRate =
            script.totalCalls > 0 ? (script.successfulCalls / script.totalCalls) * 100 : 0;
          // const flows = flowsByScript.get(script.id);

          return {
            id: script.id,
            name: script.name,
            callType: narrowCallType(script.callType),
            totalCalls: script.totalCalls,
            successRate: Math.round(successRate * 100) / 100,
            template: script.template,
          };
        }),
      };
    } catch (error) {
      this.logger.error('Error getting top scripts:', error);
      throw error;
    }
  }

  /**
   * Get system health metrics (includes conversation flow stats)
   */
  async getSystemHealth(
    companyId?: string,
    period?: 'hour' | 'day' | 'week' | 'month',
  ): Promise<{
    status: 'healthy' | 'warning' | 'critical';
    metrics: {
      activeCallsCount: number;
      failedCallsRate: number;
      retriedCallsRate: number;
      inactiveScriptsCount: number;
      avgCallDuration: number | string;
      totalFlows: number;
      publishedFlows: number;
      draftFlows: number;
      totalAgents: number;
      publishedAgents: number;
    };
    flowStats: {
      total: number;
      published: number;
      draft: number;
      archived: number;
    };
    agentStats: {
      total: number;
      published: number;
      unpublished: number;
    };
    /** Twilio balance + ElevenLabs character subscription (env credentials). */
    providerCredits: ProviderCreditsHealthDto;
    issues: string[];
  }> {
    try {
      let memoryCallStats: ReturnType<CallStateService['getStats']>;
      let scriptStats: Awaited<ReturnType<CallScriptService['getStats']>>;
      let callsForMetrics: CallRecord[];
      if (companyId) {
        memoryCallStats = this.callStateService.getStats(companyId);
        scriptStats = await this.callScriptService.getStats(companyId);
        if (period) {
          const since = new Date(Date.now() - volumePeriodSpec(period).rangeMs);
          callsForMetrics = await this.callRecordService.findSince(since, companyId);
        } else {
          callsForMetrics = await this.callRecordService.findAll(undefined, companyId);
        }
      } else {
        memoryCallStats = this.callStateService.getStats();
        scriptStats = await this.callScriptService.getStats();
        if (period) {
          const since = new Date(Date.now() - volumePeriodSpec(period).rangeMs);
          callsForMetrics = await this.callRecordService.findSince(since);
        } else {
          callsForMetrics = await this.callRecordService.findAll();
        }
      }

      const flowStats = await this.flowsService.getStats(companyId);
      const agentStats = await this.agentsService.getStats(companyId ?? null);

      // Calculate metrics
      const byStatus: Record<string, number> = {};
      for (const c of callsForMetrics) {
        byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      }

      const activeCallsCount =
        period != null
          ? (byStatus.active ?? 0) + (byStatus.initiating ?? 0)
          : memoryCallStats.byStatus.active ?? 0;
      const completedCalls = byStatus.completed ?? 0;
      const failedCalls = (byStatus.failed ?? 0) + (byStatus.cancelled ?? 0);
      const totalFinished = completedCalls + failedCalls;
      const failedCallsRate = totalFinished > 0 ? (failedCalls / totalFinished) * 100 : 0;
      const retriedCalls = byStatus.retried ?? 0;
      const retriedCallsRate = totalFinished > 0 ? (retriedCalls / totalFinished) * 100 : 0;
      // Calculate average call duration from completed calls
      const callsWithDuration = callsForMetrics.filter(c => c.status === 'completed' && c.duration);
      const avgCallDuration =
        callsWithDuration.length > 0
          ? callsWithDuration.reduce((sum, call) => sum + (call.duration ?? 0), 0) /
            callsWithDuration.length
          : 0;

      // Detect issues
      const issues: string[] = [];
      let status: 'healthy' | 'warning' | 'critical' = 'healthy';

      if (failedCallsRate > 30) {
        issues.push(`High failure rate: ${failedCallsRate.toFixed(1)}%`);
        status = 'critical';
      } else if (failedCallsRate > 15) {
        issues.push(`Elevated failure rate: ${failedCallsRate.toFixed(1)}%`);
        status = 'warning';
      }

      if (retriedCallsRate > 20) {
        issues.push(`High retry rate: ${retriedCallsRate.toFixed(1)}%`);
        status = status === 'critical' ? 'critical' : 'warning';
      } else if (retriedCallsRate > 10) {
        issues.push(`Elevated retry rate: ${retriedCallsRate.toFixed(1)}%`);
        status = 'warning';
      }

      if (!scriptStats.hasDefault) {
        issues.push('No default script configured');
        status = status === 'critical' ? 'critical' : 'warning';
      }

      if (scriptStats.active === 0) {
        issues.push('No active scripts available');
        status = 'critical';
      }

      if (flowStats.total > 0 && flowStats.published === 0) {
        issues.push('No published conversation flows');
        status = status === 'critical' ? 'critical' : 'warning';
      }

      if (agentStats.total > 0 && agentStats.published === 0) {
        issues.push('No published agents');
        status = status === 'critical' ? 'critical' : 'warning';
      }

      const [elevenLabsHealth, telnyxHealth] = await Promise.all([
        this.fetchElevenLabsCreditsHealth(),
        // this.fetchTwilioCreditsHealth(),
        this.fetchTelnyxCreditsHealth(),
      ]);
      const providerCredits: ProviderCreditsHealthDto = {
        elevenLabs: elevenLabsHealth,
        // twilio: twilioHealth,
        telnyx: telnyxHealth,
      };

      const el = providerCredits.elevenLabs;
      if (
        el.status === 'ok' &&
        el.charactersRemaining != null &&
        el.characterLimit != null &&
        el.characterLimit > 0 &&
        el.charactersRemaining / el.characterLimit < 0.05
      ) {
        issues.push(
          `ElevenLabs character quota almost exhausted (${String(el.charactersRemaining)} of ${String(el.characterLimit)} remaining in period)`,
        );
        if (status === 'healthy') status = 'warning';
      }

      if (providerCredits.elevenLabs.status === 'error') {
        issues.push(
          `ElevenLabs usage: ${providerCredits.elevenLabs.message ?? 'could not load subscription'}`,
        );
        status = 'critical';
      }
      // if (providerCredits.twilio.status === 'error') {
      //   issues.push(
      //     `Twilio balance: ${providerCredits.twilio.message ?? 'could not load balance'}`,
      //   );
      //   status = 'critical';
      // }

      if (providerCredits.telnyx.status === 'error') {
        issues.push(
          `Telnyx balance: ${providerCredits.telnyx.message ?? 'could not load balance'}`,
        );
        status = status === 'critical' ? 'critical' : 'warning';
      }

      const avgCallDurationInConverted = avgCallDuration;

      // Convert and format the duration
      let result = `${String(Math.round(avgCallDurationInConverted * 10) / 10)} second${avgCallDurationInConverted !== 1 ? 's' : ''}`;

      if (avgCallDurationInConverted < 3600) {
        const minutes = Math.floor(avgCallDurationInConverted / 60);
        this.logger.debug(
          `Average call duration: ${String(avgCallDurationInConverted)}s → ${String(minutes)} min`,
        );
        result = `${String(minutes)} minute${minutes !== 1 ? 's' : ''}`;
      } else {
        const hours = Math.floor(avgCallDurationInConverted / 3600);
        this.logger.debug(
          `Average call duration: ${String(avgCallDurationInConverted)}s → ${String(hours)} h`,
        );
        result = `${String(hours)} hour${hours !== 1 ? 's' : ''}`;
      }

      return {
        status,
        metrics: {
          activeCallsCount,
          failedCallsRate: Math.round(failedCallsRate * 100) / 100,
          retriedCallsRate: Math.round(retriedCallsRate * 100) / 100,
          inactiveScriptsCount: scriptStats.inactive,
          avgCallDuration: result,
          totalFlows: flowStats.total,
          publishedFlows: flowStats.published,
          draftFlows: flowStats.draft,
          totalAgents: agentStats.total,
          publishedAgents: agentStats.published,
        },
        flowStats: {
          total: flowStats.total,
          published: flowStats.published,
          draft: flowStats.draft,
          archived: flowStats.archived,
        },
        agentStats: {
          total: agentStats.total,
          published: agentStats.published,
          unpublished: agentStats.unpublished,
        },
        providerCredits,
        issues,
      };
    } catch (error) {
      this.logger.error('Error getting system health:', error);
      throw error;
    }
  }

  private async fetchElevenLabsCreditsHealth(): Promise<ElevenLabsCreditsHealthDto> {
    const cfg = this.configService.get<ConfigType<typeof elevenlabsConfig>>('elevenlabs');
    const apiKey = cfg?.apiKey?.trim();
    const base = (cfg?.baseUrl ?? 'https://api.elevenlabs.io/v1').replace(/\/$/, '');
    if (!apiKey) {
      return { status: 'unconfigured', message: 'ELEVENLABS_API_KEY is not configured' };
    }
    const url = `${base}/user/subscription`;
    try {
      const res = await fetch(url, { headers: { 'xi-api-key': apiKey } });
      if (!res.ok) {
        const snippet = (await res.text()).slice(0, 200);
        this.logger.warn(`ElevenLabs subscription: HTTP ${String(res.status)} ${snippet}`);
        return { status: 'error', message: `ElevenLabs API error (${String(res.status)})` };
      }
      const raw: unknown = await res.json();
      return this.mapElevenLabsSubscription(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`ElevenLabs subscription fetch failed: ${msg}`);
      return { status: 'error', message: msg };
    }
  }

  private mapElevenLabsSubscription(raw: unknown): ElevenLabsCreditsHealthDto {
    if (typeof raw !== 'object' || raw === null) {
      return { status: 'error', message: 'Invalid ElevenLabs response' };
    }
    const o = raw as Record<string, unknown>;
    const tier = typeof o.tier === 'string' ? o.tier : undefined;
    const characterCount = toFiniteNumber(o.character_count);
    const characterLimit = toFiniteNumber(o.character_limit);
    let charactersRemaining: number | null = null;
    if (characterLimit != null && characterLimit > 0 && characterCount != null) {
      charactersRemaining = Math.max(0, characterLimit - characterCount);
    }
    const nextRaw = o.next_character_count_reset_unix;
    const nextReset =
      typeof nextRaw === 'number'
        ? nextRaw
        : typeof nextRaw === 'string'
          ? Number.parseInt(nextRaw, 10)
          : NaN;
    return {
      status: 'ok',
      tier,
      characterCount: characterCount ?? undefined,
      characterLimit: characterLimit ?? undefined,
      charactersRemaining,
      nextCharacterCountResetUnix: Number.isFinite(nextReset) ? nextReset : undefined,
    };
  }

  private async fetchTwilioCreditsHealth(): Promise<TwilioCreditsHealthDto> {
    const accountSid = this.configService.get<string>('twilio.accountSid');
    const authToken = this.configService.get<string>('twilio.authToken');
    if (!accountSid?.trim() || !authToken?.trim()) {
      return { status: 'unconfigured', message: 'Twilio credentials are not configured' };
    }
    try {
      const { balance, currency } = await this.twilioClient.getAccountBalance();
      return { status: 'ok', balance, currency };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Twilio balance fetch failed: ${msg}`);
      return { status: 'error', message: msg };
    }
  }

  private async fetchTelnyxCreditsHealth(): Promise<TelnyxCreditsHealthDto> {
    if (!this.telnyxClient.isConfigured()) {
      return { status: 'unconfigured', message: 'Telnyx credentials are not configured' };
    }
    try {
      const { availableCredit, currency } = await this.telnyxClient.getAccountBalance();
      return { status: 'ok', availableCredit, currency };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Telnyx CreditsHealth: ${msg}`);
      return { status: 'error', message: msg };
    }
  }
}
