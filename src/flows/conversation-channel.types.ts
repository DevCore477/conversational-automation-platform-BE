export type ConversationChannel = 'voice' | 'whatsapp';

export function defaultFlowGoodbye(channel: ConversationChannel): string {
  return channel === 'whatsapp'
    ? 'Thank you for messaging. Have a great day!'
    : 'Thank you. Goodbye.';
}

export function defaultFlowFallbackReply(channel: ConversationChannel): string {
  return channel === 'whatsapp' ? 'How can I help you?' : 'Could you tell me a bit more?';
}

export function defaultFlowOpening(channel: ConversationChannel): string {
  return channel === 'whatsapp'
    ? 'Hello! How can I help you today?'
    : 'Hello! How can I help you today?';
}

/** Reword voice/call phrasing for WhatsApp threads. */
export function adaptFlowTextForChannel(text: string, channel: ConversationChannel): string {
  if (channel !== 'whatsapp' || !text.trim()) {
    return text;
  }

  let out = text
    .replace(/thank you for calling/gi, 'Thank you for messaging')
    .replace(/thanks for calling/gi, 'Thanks for messaging')
    .replace(/thanks for picking up/gi, 'Thanks for your message')
    .replace(/\bthe call\b/gi, 'our chat')
    .replace(/\bthis call\b/gi, 'this chat')
    .replace(/\bphone call\b/gi, 'conversation')
    .replace(/\bhang up\b/gi, 'end the chat')
    .replace(/\bhanging up\b/gi, 'ending the chat')
    .replace(/\bon the phone\b/gi, 'here on WhatsApp')
    .replace(/\bphone agent\b/gi, 'assistant')
    .replace(/\bphone assistant\b/gi, 'assistant')
    .replace(/\bgoodbye[.!]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!out) {
    return defaultFlowGoodbye('whatsapp');
  }
  return out;
}

export function channelAgentRules(channel: ConversationChannel): string {
  if (channel === 'whatsapp') {
    return [
      'You are replying on WhatsApp messaging — not a phone call.',
      'Keep messages concise (under 500 characters when possible).',
      'Never mention calling, hanging up, picking up the phone, or voice calls.',
      'Use natural chat tone suitable for text messages.',
    ].join(' ');
  }
  return 'You are a phone agent in control of this call. Stay on script.';
}
