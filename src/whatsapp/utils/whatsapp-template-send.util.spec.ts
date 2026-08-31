import {
  buildTemplateSendComponents,
  extractNamedBodyParamNames,
  formatTemplatePreviewBody,
  orderedTemplateValues,
  resolveCampaignTemplateSendVars,
} from './whatsapp-template-send.util';

const namedTemplateComponents = [
  {
    type: 'BODY',
    text: 'Hello {{name}}, appointment {{appointment_type}} on {{day}} at {{time}}.',
    example: {
      body_text_named_params: [
        { param_name: 'name', example: 'User' },
        { param_name: 'appointment_type', example: 'Dental' },
        { param_name: 'day', example: 'Monday' },
        { param_name: 'time', example: '4 PM' },
      ],
    },
  },
];

describe('whatsapp-template-send.util', () => {
  it('builds body parameters from positional list', () => {
    expect(
      buildTemplateSendComponents({
        parameters: ['John', 'ORD-99'],
      }),
    ).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'John' },
          { type: 'text', text: 'ORD-99' },
        ],
      },
    ]);
  });

  it('builds header, body, and button components', () => {
    const components = buildTemplateSendComponents({
      headerParameters: ['Hello'],
      bodyParameters: ['John', 'Tomorrow'],
      buttonParameters: [{ index: 0, subType: 'url', parameters: ['tracking-123'] }],
    });

    expect(components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'Hello' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'John' },
          { type: 'text', text: 'Tomorrow' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'tracking-123' }],
      },
    ]);
  });

  it('orders contentVariables numerically', () => {
    expect(orderedTemplateValues({ '2': 'b', '1': 'a' })).toEqual(['a', 'b']);
  });

  it('formats template preview with body placeholders', () => {
    const preview = formatTemplatePreviewBody('Hi {{1}}, order {{2}}.', ['Ali', '99']);
    expect(preview).toBe('Hi Ali, order 99.');
  });

  it('extracts named body param order from synced components', () => {
    expect(extractNamedBodyParamNames(namedTemplateComponents)).toEqual([
      'name',
      'appointment_type',
      'day',
      'time',
    ]);
  });

  it('builds named body parameters for Meta Cloud API', () => {
    expect(
      buildTemplateSendComponents({
        templateComponents: namedTemplateComponents,
        contentVariables: {
          name: 'John',
          appointment_type: 'Dental',
          day: 'Monday',
          time: '4 PM',
        },
      }),
    ).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', parameter_name: 'name', text: 'John' },
          { type: 'text', parameter_name: 'appointment_type', text: 'Dental' },
          { type: 'text', parameter_name: 'day', text: 'Monday' },
          { type: 'text', parameter_name: 'time', text: '4 PM' },
        ],
      },
    ]);
  });

  it('formats named template preview', () => {
    const preview = formatTemplatePreviewBody(
      'Hello {{name}}, on {{day}}.',
      [],
      { name: 'John', day: 'Monday' },
    );
    expect(preview).toBe('Hello John, on Monday.');
  });

  it('maps campaign CSV named columns to named template variables', () => {
    expect(
      resolveCampaignTemplateSendVars(
        {
          variables: {
            name: 'John',
            appointment_type: 'Dental',
            day: 'Monday',
            time: '4 PM',
          },
        },
        ['name', 'appointment_type', 'day', 'time'],
      ),
    ).toEqual({
      contentVariables: {
        name: 'John',
        appointment_type: 'Dental',
        day: 'Monday',
        time: '4 PM',
      },
    });
  });

  it('maps campaign CSV param1..n columns to named template variables', () => {
    expect(
      resolveCampaignTemplateSendVars(
        {
          templateParams: ['John', 'Dental', 'Monday', '4 PM'],
          variables: {
            param1: 'John',
            param2: 'Dental',
            param3: 'Monday',
            param4: '4 PM',
          },
        },
        ['name', 'appointment_type', 'day', 'time'],
      ),
    ).toEqual({
      contentVariables: {
        name: 'John',
        appointment_type: 'Dental',
        day: 'Monday',
        time: '4 PM',
      },
    });
  });

  it('keeps positional parameters for positional templates', () => {
    expect(
      resolveCampaignTemplateSendVars(
        {
          templateParams: ['John', 'ORD-99'],
          variables: { param1: 'John', param2: 'ORD-99' },
        },
        [],
      ),
    ).toEqual({
      parameters: ['John', 'ORD-99'],
    });
  });
});
