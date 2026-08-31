export interface DashboardOverviewDto {
  summary: {
    totalCalls: number;
    activeCalls: number;
    totalScripts: number;
    activeScripts: number;
    totalFlows: number;
    publishedFlows: number;
    totalAgents: number;
    publishedAgents: number;
  };
  callStats: {
    total: number;
    byStatus: {
      initiating: number;
      active: number;
      completed: number;
      failed: number;
      retried: number;
    };
    successRate: number;
  };
  scriptStats: {
    total: number;
    active: number;
    inactive: number;
    byCallType: {
      inbound: number;
      outbound: number;
      both: number;
    };
    totalCallsMade: number;
    mostUsedScript: {
      name: string;
      calls: number;
    } | null;
  };
  /** Conversation flow inventory and rolled-up usage on flow entities. */
  flowStats: {
    total: number;
    published: number;
    draft: number;
    archived: number;
    totalCallsOnFlows: number;
    successfulCallsOnFlows: number;
    failedCallsOnFlows: number;
  };
  /** Agent inventory (publish state and channel). */
  agentStats: {
    total: number;
    published: number;
    unpublished: number;
    byChannel: Record<string, number>;
  };
  recentActivity: {
    last24Hours: number;
    lastHour: number;
    /** Last 24h calls by primary attribution: agent → flow → script → other. */
    last24HoursByResource: {
      agent: number;
      conversationFlow: number;
      script: number;
      other: number;
    };
  };
}

export interface ScriptPerformanceDto {
  id: string;
  name: string;
  callType: 'inbound' | 'outbound' | 'both';
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  activeCalls: number;
  retriedCalls: number;
  successRate: number;
  lastUsedAt: Date | null;
  isActive: boolean;
  isDefault: boolean;
}

export interface FlowPerformanceDto {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'archived';
  scriptId: string | null;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  activeCalls: number;
  retriedCalls: number;
  successRate: number;
  lastUsedAt: Date | null;
}

export interface AgentPerformanceDto {
  id: string;
  agentName: string;
  channel: string;
  isPublished: boolean;
  responseEngineType: 'conversation-flow' | 'script' | 'llm' | 'unknown';
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  activeCalls: number;
  retriedCalls: number;
  successRate: number;
}

/** Time-bucket usage (aligned with GET .../calls/volume/by-resource grain). */
export interface PerformanceUsageBucketDto {
  timestamp: Date;
  total: number;
  completed: number;
  failed: number;
  active: number;
  retried: number;
}

/** Volume + outcome mix over time for a scoped template or aggregate. */
export interface PerformanceUsageSeriesDto {
  /** Bucket layout preset (same as calls/volume/by-resource). */
  period: 'hour' | 'day' | 'week' | 'month';
  /** Inclusive-ish window used for DB fetch and buckets (`to` matches query filter). */
  window: { from: Date; to: Date };
  data: PerformanceUsageBucketDto[];
  totals: {
    total: number;
    completed: number;
    failed: number;
    active: number;
    retried: number;
  };
  peak: { timestamp: Date; count: number };
}

/** Agent performance: per-agent KPIs plus time-series usage in the requested window. */
export interface AgentPerformanceReportDto {
  agents: AgentPerformanceDto[];
  usage: PerformanceUsageSeriesDto;
}

export interface FlowPerformanceReportDto {
  flows: FlowPerformanceDto[];
  usage: PerformanceUsageSeriesDto;
}

export interface ScriptPerformanceReportDto {
  scripts: ScriptPerformanceDto[];
  usage: PerformanceUsageSeriesDto;
}

/** Populated after inbound calls complete (from metadata.inboundInsight). */
export interface InboundCallInsightDto {
  category: string;
  purpose: string;
  summary: string;
}

export interface CallActivityDto {
  callSid: string;
  status: string;
  phoneNumberFrom: string;
  phoneNumberTo: string;
  template: string;
  createdAt: Date;
  updatedAt: Date;
  duration?: number;
  /** Script used for this call (null if none). */
  scriptUsed: { id: string; name: string } | null;
  /** Conversation flow used for this call (null if none or unresolved). */
  flowUsed: { id: string; name: string } | null;
  /** Agent that owned the call when routed via agent (metadata.agentId). */
  agentUsed: { id: string; name: string } | null;
  /** flowId from metadata when flowUsed is null (for debugging). */
  flowIdFromMetadata?: string | null;
  /** Structured summary for inbound calls (query, demo, bug, etc.). */
  inboundInsight?: InboundCallInsightDto | null;
}

export interface TimeSeriesDataPoint {
  timestamp: Date;
  count: number;
}

export interface CallVolumeDto {
  period: string;
  data: TimeSeriesDataPoint[];
  total: number;
  peak: {
    timestamp: Date;
    count: number;
  };
}

export interface ResourceVolumeBucket {
  timestamp: Date;
  agent: number;
  conversationFlow: number;
  script: number;
  other: number;
}

export interface ResourceCallVolumeDto {
  period: 'hour' | 'day' | 'week' | 'month';
  data: ResourceVolumeBucket[];
  totals: {
    agent: number;
    conversationFlow: number;
    script: number;
    other: number;
  };
  peak: {
    timestamp: Date;
    count: number;
  };
}

export interface TopScriptsDto {
  templates: {
    id: string;
    name: string;
    callType: 'inbound' | 'outbound' | 'both';
    totalCalls: number;
    successRate: number;
    template: string;
  }[];
}
