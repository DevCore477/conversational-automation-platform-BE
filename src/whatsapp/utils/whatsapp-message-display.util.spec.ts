import {
  buildTemplateMessagePreview,
  extractMessageTemplateParameterValues,
  extractTemplatePlaceholderNames,
  isTemplatePlaceholderBody,
  resolveMessageDisplayBody,
} from './whatsapp-message-display.util';

describe('whatsapp-message-display.util', () => {
  const template = {
    name: 'Hexa Ai Template',
    metaTemplateName: 'hexa_ai_template',
    bodyPreview:
      'Hello {{name}}, your appointment for {{appointment_type}} on {{day}} at {{time}} is confirmed.',
  };

  it('detects legacy template placeholder bodies', () => {
    expect(isTemplatePlaceholderBody('[template:hexa_ai_template]')).toBe(true);
    expect(isTemplatePlaceholderBody('Hello Ali')).toBe(false);
  });

  it('renders named template variables into a readable body', () => {
    expect(
      buildTemplateMessagePreview(template.bodyPreview, {
        contentVariables: {
          name: 'Ali',
          appointment_type: 'Dental',
          day: 'Monday',
          time: '4 PM',
        },
      }),
    ).toBe(
      'Hello Ali, your appointment for Dental on Monday at 4 PM is confirmed.',
    );
  });

  it('replaces legacy placeholder bodies using template metadata', () => {
    expect(
      resolveMessageDisplayBody('[template:hexa_ai_template]', template, {
        contentVariables: { name: 'Ali', appointment_type: 'Dental', day: 'Monday', time: '4 PM' },
      }),
    ).toBe(
      'Hello Ali, your appointment for Dental on Monday at 4 PM is confirmed.',
    );
  });

  it('returns ordered send values for named templates without exposing slot names', () => {
    const order = extractTemplatePlaceholderNames(
      [
        {
          type: 'BODY',
          example: {
            body_text_named_params: [
              { param_name: 'name' },
              { param_name: 'appointment_type' },
              { param_name: 'day' },
              { param_name: 'time' },
            ],
          },
        },
      ],
      template.bodyPreview,
    );

    expect(
      extractMessageTemplateParameterValues(
        {
          contentVariables: {
            name: 'Ali',
            appointment_type: 'Dental',
            day: 'Monday',
            time: '4 PM',
          },
        },
        order,
      ),
    ).toEqual(['Ali', 'Dental', 'Monday', '4 PM']);
  });

  it('returns positional send values as-is', () => {
    expect(
      extractMessageTemplateParameterValues({ parameters: ['Ali', 'ORD-99'] }),
    ).toEqual(['Ali', 'ORD-99']);
  });
});
