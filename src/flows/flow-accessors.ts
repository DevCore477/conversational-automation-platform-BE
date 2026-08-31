/**
 * Flow accessors: read from either new (nodes array, instruction, edges) or legacy (nodes Record, say, transitions) format.
 * All flow runtime and prompt builder code should use these instead of reading flow/node shape directly.
 */

import {
  ConversationFlowJSON,
  ConversationFlowJSONNew,
  ElevenLabsToolDefinition,
  FlowEdge,
  FlowNodeLegacy,
  ConversationNode,
  FlowNodeNew,
  FlowSlotDefinition,
  isNewFlowFormat,
} from './types/flows.types';

export type { FlowNodeLegacy };

export interface NormalizedNode {
  id?: string;
  say?: { template?: string; prompt?: string };
  /** Present for `transfer_call` nodes with a phone destination: PSTN number before normalization. */
  transferDial?: { toE164: string };
  /** Present for `transfer_call` nodes with a `flow` destination: internal handoff, no telephony. */
  transferFlow?: { flowId: string };
  /** Present for `transfer_call` nodes with an `agent` destination: internal handoff to another Agent. */
  transferAgent?: { agentId: string };
  listen?: {
    capture_slot?: string;
    next?: string;
    intent_scope?: string[];
    fallback?: string;
  };
  transitions?: ({ to: string } | { on_intent: string; to: string })[];
  end?: boolean;
  /** True for `transfer_call` nodes (new flow format): call is handed off to a human, like `end` ends it. */
  transfer?: boolean;
  position?: { x: number; y: number };
  tool?: { name: string; payload?: Record<string, unknown> };
  /** 0 = do not allow user to interrupt agent; 1 = allow (default). Per-node for natural turn-taking. */
  interruption_sensitivity?: number;
}

interface NestedFlowPayload {
  flow?: unknown;
  intents?: Record<string, { rules: string[] }>;
}

function isConversationFlowInner(
  inner: unknown,
): inner is Pick<ConversationFlowJSONNew, 'nodes' | 'start_node_id' | 'intents'> {
  if (!inner || typeof inner !== 'object') return false;
  const o = inner as { nodes?: unknown; start_node_id?: unknown };
  return Array.isArray(o.nodes) && typeof o.start_node_id === 'string';
}

/**
 * Unwrap nested flow when stored as { start, flow: { nodes, start_node_id }, intents }.
 * Returns the inner flow so getNode/getNodesMap/getStartNodeId work on the actual nodes.
 */
export function getEffectiveFlow(flow: unknown): ConversationFlowJSON {
  if (!flow || typeof flow !== 'object') {
    return flow as ConversationFlowJSON;
  }
  const wrapper = flow as NestedFlowPayload;
  const inner = wrapper.flow;
  if (isConversationFlowInner(inner)) {
    const innerFlow = inner as ConversationFlowJSONNew;
    const outerSlots = (wrapper as { slot_definitions?: Record<string, FlowSlotDefinition> })
      .slot_definitions;
    return {
      ...innerFlow,
      intents: wrapper.intents ?? innerFlow.intents ?? {},
      slot_definitions: {
        ...(innerFlow.slot_definitions ?? {}),
        ...(outerSlots ?? {}),
      },
    } as ConversationFlowJSON;
  }
  return flow as ConversationFlowJSON;
}

/** Tool definitions attached to the flow JSON. */
export function getFlowToolDefinitions(flow: unknown): ElevenLabsToolDefinition[] {
  if (!flow || typeof flow !== 'object') return [];
  const outer = flow as { tools?: ElevenLabsToolDefinition[] };
  if (Array.isArray(outer.tools) && outer.tools.length > 0) {
    return outer.tools;
  }
  const effective = getEffectiveFlow(flow);
  return effective.tools ?? [];
}

/** Lookup one tool by name (includes optional JSON-schema `returns` for editors). */
export function getFlowToolDefinition(
  flow: unknown,
  toolName: string,
): ElevenLabsToolDefinition | undefined {
  const trimmed = toolName.trim();
  return getFlowToolDefinitions(flow).find(t => t.name === trimmed);
}

/** Get start node id (works for both new and legacy flow format). */
export function getStartNodeId(flow: ConversationFlowJSON): string {
  if (isNewFlowFormat(flow)) {
    return flow.start_node_id;
  }
  return flow.start;
}

/** Get node by id or by name. Returns normalized view for new format, legacy node for legacy format. */
export function getNode(
  flow: ConversationFlowJSON,
  nodeId: string,
): NormalizedNode | FlowNodeLegacy | null {
  if (isNewFlowFormat(flow)) {
    const nodes = flow.nodes;
    let node: FlowNodeNew | undefined = nodes.find((n: FlowNodeNew) => n.id === nodeId);
    node ??= nodes.find((n: FlowNodeNew) => n.name === nodeId);
    return node ? normalizeNode(node) : null;
  }
  const nodes = flow.nodes;
  return nodes[nodeId] ?? null;
}

function edgeToConditionAndDest(
  e: FlowEdge,
): { condition: string; destination_node_id: string } | null {
  const dest = e.destination_node_id;
  if (typeof dest !== 'string' || dest === '') return null;
  const fromPrompt = e.transition_condition.prompt;
  const condition =
    fromPrompt.trim() !== '' ? fromPrompt : e.condition.trim() !== '' ? e.condition : e.id;
  return { condition, destination_node_id: dest };
}

/** Slot definitions declared on the flow JSON. */
export function getFlowSlotDefinitions(
  flow: ConversationFlowJSON,
): Record<string, FlowSlotDefinition> {
  if (!isNewFlowFormat(flow)) return {};
  return flow.slot_definitions ?? {};
}

export function getFlowSlotDefinition(
  flow: ConversationFlowJSON,
  slotName: string,
): FlowSlotDefinition | undefined {
  return getFlowSlotDefinitions(flow)[slotName];
}

/** Multi-item flows: when basket has items, "done" phrases skip to this node. */
export function getBasketDoneDestination(
  flow: ConversationFlowJSON,
  nodeId: string,
): string | undefined {
  if (!isNewFlowFormat(flow)) return undefined;
  const nodes = flow.nodes;
  let node: FlowNodeNew | undefined = nodes.find(n => n.id === nodeId);
  node ??= nodes.find(n => n.name === nodeId);
  if (node?.type !== 'conversation') return undefined;
  const dest = (node as ConversationNode).basket_done_destination;
  return typeof dest === 'string' && dest.trim() !== '' ? dest.trim() : undefined;
}

/** Raw edges for a node (includes when_slot_value for dynamic routing). */
export function getNodeEdges(flow: ConversationFlowJSON, nodeId: string): FlowEdge[] {
  if (!isNewFlowFormat(flow)) return [];
  const nodes = flow.nodes;
  let node: FlowNodeNew | undefined = nodes.find(n => n.id === nodeId);
  node ??= nodes.find(n => n.name === nodeId);
  if (!node || !('edges' in node) || !Array.isArray(node.edges)) return [];
  return node.edges.filter(
    (e): e is FlowEdge & { destination_node_id: string } =>
      typeof e.destination_node_id === 'string' && e.destination_node_id !== '',
  );
}

/** Get raw edges (condition + destination) for a node. Used for LLM-based edge selection in new flow format. */
export function getEdgesForNode(
  flow: ConversationFlowJSON,
  nodeId: string,
): { condition: string; destination_node_id: string }[] | null {
  if (!isNewFlowFormat(flow)) return null;
  const nodes = flow.nodes;
  let node: FlowNodeNew | undefined = nodes.find((n: FlowNodeNew) => n.id === nodeId);
  node ??= nodes.find((n: FlowNodeNew) => n.name === nodeId);
  if (!node || !('edges' in node) || !Array.isArray(node.edges)) return null;
  const mapped = node.edges
    .map(e => edgeToConditionAndDest(e))
    .filter((x): x is { condition: string; destination_node_id: string } => x != null);
  return mapped.length ? mapped : null;
}

/** Build a Record<id, node> for flows that use nodes array (so callers can still do flowNodes[id]). */
export function getNodesMap(
  flow: ConversationFlowJSON,
): Record<string, NormalizedNode | FlowNodeLegacy> {
  if (isNewFlowFormat(flow)) {
    const map: Record<string, NormalizedNode> = {};
    const nodes = flow.nodes;
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        const normalized = normalizeNode(n);
        if (n.id) map[n.id] = { ...normalized, id: n.id };
      }
    }
    return map;
  }
  return flow.nodes;
}

/** Convert new-format node to normalized shape (say, listen, transitions, end, position). */
function normalizeNode(node: FlowNodeNew): NormalizedNode {
  const base: NormalizedNode = {
    say: undefined,
    listen: undefined,
    transitions: undefined,
    end: false,
    position: undefined,
    interruption_sensitivity: undefined,
  };

  // End nodes: always treat instruction as prompt so the AI generates a proper goodbye (not literal "Politely end the call...")
  if (node.type === 'end') {
    base.end = true;
    const trimmed = node.instruction?.text.trim();
    if (trimmed !== undefined && trimmed !== '') {
      base.say = { prompt: trimmed };
    }
    base.position = node.display_position;
    return base;
  }

  const text = node.instruction?.text.trim();
  if (text !== undefined && text !== '') {
    const looksLikeTemplate = !/^(say|ask|tell|apologize|thank)/i.test(text) || /^["']/.test(text);
    if (looksLikeTemplate) {
      base.say = { template: text };
    } else {
      base.say = { prompt: text };
    }
  }

  if (node.type === 'transfer_call') {
    base.position = node.display_position;
    base.transfer = true;
    if (node.instruction?.text) {
      base.say = base.say ?? { prompt: node.instruction.text };
    }
    // Accept both the documented shape (type: 'flow'/'agent' + dedicated flowId/agentId field) and
    // the `_id`-suffixed variant callers commonly send (type: 'flow_id'/'agent_id', matching how
    // `phone_number` names its own destination value) — falling back to `number` for the id itself
    // when a dedicated field isn't present, since that's where callers often put it either way.
    const destType = node.transfer_destination.type;
    if (destType === 'flow' || destType === 'flow_id') {
      const flowId = (node.transfer_destination.flowId ?? node.transfer_destination.number)?.trim();
      if (flowId) {
        base.transferFlow = { flowId };
      }
    } else if (destType === 'agent' || destType === 'agent_id') {
      const agentId = (
        node.transfer_destination.agentId ?? node.transfer_destination.number
      )?.trim();
      if (agentId) {
        base.transferAgent = { agentId };
      }
    } else {
      const raw = node.transfer_destination.number?.trim();
      if (raw) {
        base.transferDial = { toE164: raw };
      }
    }
    // Optional continuation after the transfer (e.g. a warm-transfer fallback node) — same shape
    // as conversation/tool transitions so graph tools (reachability, dead-end checks) see it.
    const edgeMapped = edgeToConditionAndDest(node.edge);
    if (edgeMapped) {
      base.transitions = [{ to: edgeMapped.destination_node_id }];
    }
    return base;
  }

  // Conversation nodes: edges + listen (slot capture / next transition).
  // Tool nodes: edges + transitions only — no listen. Tools run server-side and branch on result; they never wait for user input at this step.
  if (
    (node.type === 'conversation' || node.type === 'tool') &&
    'edges' in node &&
    Array.isArray(node.edges)
  ) {
    const edges = node.edges.filter(
      (e): e is FlowEdge & { destination_node_id: string } =>
        typeof e.destination_node_id === 'string' && e.destination_node_id !== '',
    );
    base.transitions = edges.map((e, i) => {
      const to = e.destination_node_id;
      const fromPrompt = e.transition_condition.prompt;
      const onIntent =
        fromPrompt.trim() !== '' ? fromPrompt : e.condition.trim() !== '' ? e.condition : e.id;
      return i === 0 ? { to } : { on_intent: onIntent, to };
    }) as NormalizedNode['transitions'];
    if (node.type === 'conversation') {
      const firstEdge = edges[0];
      const fallbackEdge = node.skip_response_edge?.destination_node_id;
      base.listen = {
        next: firstEdge.destination_node_id,
        fallback: fallbackEdge ?? (edges.length === 1 ? edges[0].destination_node_id : undefined),
        ...(node.capture_slot ? { capture_slot: node.capture_slot } : {}),
      };
    }
    base.interruption_sensitivity =
      (node as { interruption_sensitivity?: number }).interruption_sensitivity ?? 1;
  }

  if (node.type === 'tool') {
    const tn = node;
    const ref = tn.tool;
    if (ref.name) {
      const payload =
        ref.payload ??
        (ref.parameters && typeof ref.parameters === 'object'
          ? Object.fromEntries(
              Object.entries(ref.parameters).map(([k, v]) => [
                k,
                typeof v === 'string' ? v : JSON.stringify(v),
              ]),
            )
          : undefined);
      base.tool = {
        name: ref.name,
        ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
      };
    }
  }

  base.position = node.display_position;
  return base;
}

/** Get say template (exact text to say) from a node. Works for both normalized and legacy. */
/** PSTN number from a `transfer_call` node, if any (normalize with `normalizePhoneNumber` before dialing). */
export function getTransferDialTo(
  node: NormalizedNode | FlowNodeLegacy | null,
): string | undefined {
  const raw = (node as NormalizedNode | null)?.transferDial?.toE164;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** Target flow id from a `transfer_call` node whose destination type is `flow` (internal handoff). */
export function getTransferFlowId(
  node: NormalizedNode | FlowNodeLegacy | null,
): string | undefined {
  const raw = (node as NormalizedNode | null)?.transferFlow?.flowId;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** Target agent id from a `transfer_call` node whose destination type is `agent` (internal handoff). */
export function getTransferAgentId(
  node: NormalizedNode | FlowNodeLegacy | null,
): string | undefined {
  const raw = (node as NormalizedNode | null)?.transferAgent?.agentId;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function getSayTemplate(node: NormalizedNode | FlowNodeLegacy | null): string | undefined {
  if (!node) return undefined;
  const say = 'say' in node ? node.say : undefined;
  if (say && typeof say === 'object' && 'template' in say) {
    const t = (say as { template?: string }).template;
    return typeof t === 'string' ? t : undefined;
  }
  return undefined;
}

/** Get say prompt (instruction for AI to generate) from a node. */
export function getSayPrompt(node: NormalizedNode | FlowNodeLegacy | null): string | undefined {
  if (!node) return undefined;
  const say = 'say' in node ? node.say : undefined;
  if (say && typeof say === 'object' && 'prompt' in say) {
    const p = (say as { prompt?: string }).prompt;
    return typeof p === 'string' ? p : undefined;
  }
  return undefined;
}

/** Get single "say" text (template or prompt) for display/extraction. */
export function getSayText(node: NormalizedNode | FlowNodeLegacy | null): string {
  return getSayTemplate(node) ?? getSayPrompt(node) ?? '';
}

/** True when the active node id refers to a server-side tool step (new flow format). */
export function isToolNodeAt(flow: ConversationFlowJSON, nodeId: string): boolean {
  if (!isNewFlowFormat(flow)) {
    return false;
  }
  const raw = flow.nodes.find(n => n.id === nodeId || n.name === nodeId);
  return raw?.type === 'tool';
}

/** Whether this node is an end node. */
export function isEndNode(node: NormalizedNode | FlowNodeLegacy | null): boolean {
  if (!node) return false;
  return !!(node as NormalizedNode & FlowNodeLegacy).end;
}

/** Whether this node is a `transfer_call` node (hands the call off to a human, like `end` ends it). */
export function isTransferCallNode(node: NormalizedNode | FlowNodeLegacy | null): boolean {
  if (!node) return false;
  return !!(node as NormalizedNode).transfer;
}

/** Get listen config (capture_slot, next, fallback, intent_scope). */
export function getListen(
  node: NormalizedNode | FlowNodeLegacy | null,
): NormalizedNode['listen'] | undefined {
  if (!node) return undefined;
  return (node as NormalizedNode & FlowNodeLegacy).listen;
}

/** Get transitions (to / on_intent+to) for the node. */
export function getTransitions(
  node: NormalizedNode | FlowNodeLegacy | null,
): NormalizedNode['transitions'] {
  if (!node) return undefined;
  return (node as NormalizedNode & FlowNodeLegacy).transitions;
}

/** Get position (x, y). */
export function getPosition(
  node: NormalizedNode | FlowNodeLegacy | null,
): { x: number; y: number } | undefined {
  if (!node) return undefined;
  const n = node as NormalizedNode &
    FlowNodeLegacy & { display_position?: { x: number; y: number } };
  const pos = n.position ?? n.display_position;
  return pos && typeof pos.x === 'number' && typeof pos.y === 'number' ? pos : undefined;
}

/**
 * Get interruption sensitivity for the node (0 = do not allow user to interrupt agent, 1 = allow).
 * Used for natural turn-taking: when user speaks over agent, we stop agent only if sensitivity > 0.
 */
export function getInterruptionSensitivity(node: NormalizedNode | FlowNodeLegacy | null): number {
  if (!node) return 1;
  const v = (node as NormalizedNode & { interruption_sensitivity?: number })
    .interruption_sensitivity;
  return typeof v === 'number' ? v : 1;
}

/** Get intents from flow (same in both formats). */
export function getIntents(
  flow: ConversationFlowJSON,
): Record<string, { rules: string[] }> | undefined {
  if ('intents' in flow && flow.intents != null && typeof flow.intents === 'object') {
    return flow.intents;
  }
  return undefined;
}
