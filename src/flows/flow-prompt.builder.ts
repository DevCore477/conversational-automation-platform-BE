// flows/flow-prompt.builder.ts
import type { ConversationFlowMode } from '../agents/types/conversation-flow-mode.types';
import {
  type ConversationChannel,
  channelAgentRules,
} from './conversation-channel.types';
import { ConversationFlowJSON } from './types/flows.types';
import {
  getNode,
  getSayTemplate,
  getSayPrompt,
  getListen,
  getTransitions,
  isEndNode,
  getIntents,
} from './flow-accessors';

type FlowTransition = { to: string } | { on_intent: string; to: string };

function formatTransitionLine(t: FlowTransition): string {
  if ('on_intent' in t) {
    return `- If user intent is "${t.on_intent}", you MUST call the tool "transition_to_node" with node_id "${t.to}"`;
  }
  return `- Default next step: "${t.to}"`;
}

export function buildFlowSystemPrompt(params: {
  flow: ConversationFlowJSON;
  currentNodeId: string;
  slots: Record<string, unknown>;
  /** rigid: strict step-by-step. flex: shared flow context, more natural movement. Default rigid. */
  mode?: ConversationFlowMode;
  channel?: ConversationChannel;
}): string {
  const { flow, currentNodeId, slots, mode = 'rigid', channel = 'voice' } = params;
  const isWhatsApp = channel === 'whatsapp';
  const isFlex = mode === 'flex';
  const node = getNode(flow, currentNodeId);

  if (!node) {
    return isWhatsApp
      ? 'End the WhatsApp conversation politely with a short thank-you message.'
      : 'End the conversation politely and hang up.';
  }

  const intents = getIntents(flow);
  const intentContext = intents
    ? Object.entries(intents)
        .map(([name, def]) => {
          return `- "${name}": matches when user says something like: ${def.rules.join(', ')}`;
        })
        .join('\n')
    : '';

  const transitions = getTransitions(node);
  const transitionContext = transitions
    ? transitions.map((t: FlowTransition) => formatTransitionLine(t)).join('\n')
    : '';

  // Build slots context
  const slotsContext =
    Object.entries(slots)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `- ${k}: ${String(v)}`)
      .join('\n') || 'No information collected yet.';

  const sayTemplate = getSayTemplate(node);
  const sayPrompt = getSayPrompt(node);
  const listen = getListen(node);

  const currentTaskBlock = sayTemplate
    ? `Say exactly this (you may vary slightly for natural speech but keep the meaning): "${sayTemplate}"`
    : sayPrompt
      ? `You MUST speak to the user naturally based on this instruction: "${sayPrompt}"
      
CRITICAL: 
- DO NOT repeat the prompt text literally - interpret it and speak naturally
- If the prompt says "Ask the user how you can assist them today", you should say something like "Hello! How can I assist you today?" - NOT "Ask the user how you can assist them today"
- Speak conversationally and naturally - make it sound like a real person
- Ask questions clearly to gather the required information
- Be friendly, professional, and helpful
- The prompt is an INSTRUCTION for what to do, not text to repeat`
      : 'Listen to the user and determine their intent.';

  const listenBlock =
    listen != null
      ? `
AFTER SPEAKING, LISTEN FOR:
${intentContext ? `Available intents:\n${intentContext}` : ''}

TRANSITION RULES:
${transitionContext}
${listen.fallback ? `\nIf no intent matches, use fallback: "${listen.fallback}"` : ''}
${
  listen.capture_slot
    ? `\nCRITICAL SLOT EXTRACTION:
- You MUST extract the "${listen.capture_slot}" value from the user's response
- The user may provide this in one go (e.g. "Dr. Bilal at 2 pm") or in parts. If the step requires BOTH pieces (e.g. doctor AND time) and the user gave only ONE (e.g. only "Dr. Bilal"), do NOT store yet — acknowledge what they said and ask specifically for the missing part (e.g. "You said Dr. Bilal — which time slot works for you: Saturday 1pm–3pm, Sunday 5pm–7pm, or Saturday 10pm–12am?").
- Extract the COMPLETE value when you have it (e.g. "Dr. Bilal at 2 pm"). Use context from the conversation if they answered in two turns.
- After extracting the full value, call "store_slot" with slot_name="${listen.capture_slot}" and the value, then "transition_to_node"`
    : ''
}

TOOL USAGE:
- When you need to move to the next step, call the "transition_to_node" tool with the appropriate node_id
- When you need to store information, call the "store_slot" tool with slot_name and value
- When the conversation should end, call the "end_conversation" tool
- ALWAYS use tools to manage conversation state - don't just talk without using tools
`
      : '';

  const flowModeIntro = isWhatsApp
    ? isFlex
      ? `You are an AI assistant using a conversation flow on WhatsApp. Respond naturally in short chat messages while honoring transitions and tools.`
      : `You are an AI assistant following a strict conversation flow on WhatsApp.`
    : isFlex
      ? `You are an AI phone assistant using a conversation flow. The flow defines goals, nodes, and transitions. You have the full flow and collected slots in context — respond naturally and coherently across steps while still honoring transitions and tools.`
      : `You are an AI phone assistant following a strict conversation flow.`;

  const agenticBlock = isFlex
    ? `AGENTIC BEHAVIOR (FLEX MODE):
- Lead toward the flow's goal. The current step is your focus, but you may reference earlier parts of the conversation naturally.
- If the user gave only PART of what this step needs: acknowledge what they said, then ask for the missing part (with options when listed).
- If the user goes off-topic, acknowledge briefly, then steer back toward the flow goal without sounding robotic.
- If you didn't hear clearly, ask once in a clear, specific way.
- After interruption: acknowledge briefly, then continue helpfully; avoid repeating long blocks of text.
- Stay warm and professional; keep momentum toward completing the flow.`
    : `AGENTIC BEHAVIOR (YOU ARE IN CONTROL):
- You lead the conversation. One step at a time. Do not let the user drift off-script.
- If the user gave only PART of what this step needs (e.g. only doctor name when you need doctor AND time): acknowledge what they said, then ask clearly for the MISSING part and list options when relevant (e.g. "You said Dr. Bilal — which time: Saturday 1pm–3pm, Sunday 5pm–7pm, or Saturday 10pm–12am?").
- If the user goes off-topic, acknowledge briefly then redirect and re-ask only what the current step needs.
- If you didn't hear clearly, ask once for the required information in a clear, specific way.
- After the user interrupts you: acknowledge briefly, then re-anchor with what you still need. Do not repeat long explanations.
- If they didn't respond correctly or gave an incomplete answer, rephrase or ask for the missing piece specifically — be helpful and explicit.
- Stay warm and professional but firm: keep the user moving toward the goal without frustrating them.`;

  return `${flowModeIntro}

CURRENT STEP: ${currentNodeId}
STEP TYPE: ${isEndNode(node) ? 'END' : listen ? 'LISTEN' : 'INFORMATION'}

COLLECTED INFORMATION:
${slotsContext}

YOUR CURRENT TASK:
${currentTaskBlock}
${listenBlock}

${
  isEndNode(node)
    ? isWhatsApp
      ? `
END THE CONVERSATION:
Say a short, friendly goodbye suitable for WhatsApp. Do not mention calls or hanging up.
`
      : `
END THE CONVERSATION:
Say your goodbye message, then call the "end_conversation" tool to hang up.
`
    : ''
}

${agenticBlock}

${channelAgentRules(channel)}

TECHNICAL RULES:
- Use the tools to manage conversation state - don't just talk without using tools.
- Keep responses concise (1-2 sentences max unless explaining details).
- If the user interrupts you, STOP speaking immediately and LISTEN.
- After being interrupted, wait for the user to finish their thought before responding.
- If they interrupted with the answer you need, ACCEPT it and move forward - don't repeat the question.
- After you ask a question, stop and listen — do not add filler or repeat the menu unless the ${isWhatsApp ? 'customer' : 'caller'} asks.`;
}
