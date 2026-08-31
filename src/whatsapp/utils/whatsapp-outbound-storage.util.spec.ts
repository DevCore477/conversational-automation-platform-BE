import { resolveDesignOutboundStorage } from './whatsapp-outbound-storage.util';

describe('whatsapp-outbound-storage.util', () => {
  it('renders full template body for template designs', () => {
    const storage = resolveDesignOutboundStorage(
      {
        type: 'template',
        templateName: 'hexa_ai_template',
        parameters: ['Ali', 'Dental', 'Monday', '4 PM'],
      },
      undefined,
      {
        templateId: 'tpl-1',
        bodyPreview:
          'Hello {{1}}, your appointment for {{2}} on {{3}} at {{4}} is confirmed.',
      },
    );

    expect(storage.body).toBe(
      'Hello Ali, your appointment for Dental on Monday at 4 PM is confirmed.',
    );
    expect(storage.templateName).toBe('hexa_ai_template');
    expect(storage.payload).toEqual({
      templateId: 'tpl-1',
      templateSendVars: { parameters: ['Ali', 'Dental', 'Monday', '4 PM'] },
    });
  });
});
