import { any, string } from 'zod';

const PlatformInboundConfig = {
  platformCompanyId: string().uuid().optional().nullable(),
  routingMode: 'database_default' as 'agent' | 'flow' | 'script' | 'database_default',
  agentId: string().uuid().optional().nullable(),
  flowId: string().uuid().optional().nullable(),
  scriptId: string().uuid().optional().nullable(),
  agent: any().nullable(),
  flow: any().nullable(), // ConversationFlow entity (not defined here)
  callScript: any().nullable(), // Script entity (not defined here)
};

export default PlatformInboundConfig;
