import {
  adaptFlowTextForChannel,
  defaultFlowGoodbye,
} from './conversation-channel.types';

describe('conversation-channel.types', () => {
  it('adapts call goodbye for WhatsApp', () => {
    expect(adaptFlowTextForChannel('Thank you for calling. Have a great day! Goodbye.', 'whatsapp')).toBe(
      'Thank you for messaging. Have a great day!',
    );
  });

  it('keeps voice text unchanged', () => {
    const text = 'Thank you for calling. Goodbye.';
    expect(adaptFlowTextForChannel(text, 'voice')).toBe(text);
  });

  it('uses WhatsApp default goodbye', () => {
    expect(defaultFlowGoodbye('whatsapp')).toContain('messaging');
    expect(defaultFlowGoodbye('voice')).toContain('Goodbye');
  });
});
