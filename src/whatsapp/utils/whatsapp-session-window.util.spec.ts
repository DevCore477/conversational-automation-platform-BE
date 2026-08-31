import {
  isFreeformSessionOpen,
  requiresTemplateForFreeform,
} from './whatsapp-session-window.util';

describe('whatsapp-session-window.util', () => {
  const now = new Date('2026-05-20T12:00:00Z').getTime();

  it('requires template when customer never messaged', () => {
    const conv = { serviceWindowExpiresAt: null, lastInboundAt: null };
    expect(isFreeformSessionOpen(conv, now)).toBe(false);
    expect(requiresTemplateForFreeform(conv, now)).toBe(true);
  });

  it('allows free-form inside serviceWindowExpiresAt', () => {
    const conv = {
      serviceWindowExpiresAt: new Date('2026-05-20T18:00:00Z'),
      lastInboundAt: new Date('2026-05-20T12:00:00Z'),
    };
    expect(isFreeformSessionOpen(conv, now)).toBe(true);
  });

  it('requires template when service window expired', () => {
    const conv = {
      serviceWindowExpiresAt: new Date('2026-05-19T12:00:00Z'),
      lastInboundAt: new Date('2026-05-18T12:00:00Z'),
    };
    expect(requiresTemplateForFreeform(conv, now)).toBe(true);
  });

  it('falls back to lastInboundAt when serviceWindowExpiresAt is missing', () => {
    const conv = {
      serviceWindowExpiresAt: null,
      lastInboundAt: new Date('2026-05-20T10:00:00Z'),
    };
    expect(isFreeformSessionOpen(conv, now)).toBe(true);
  });
});
