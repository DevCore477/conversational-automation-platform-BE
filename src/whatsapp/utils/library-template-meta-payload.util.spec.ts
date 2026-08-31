import type { CreateTemplateFromLibraryInput } from '../dto/create-template-from-library.dto';
import {
  buildLibraryTemplateMetaPayload,
  resolveCustomizationMode,
} from './library-template-meta-payload.util';

describe('library-template-meta-payload.util', () => {
  const baseDto: CreateTemplateFromLibraryInput = {
    libraryTemplateName: 'appointment_cancellation_1',
    name: 'testing_hexa_new_temp_with_var',
    language: 'en',
    category: 'UTILITY',
  };

  const preview = {
    header: 'Appointment canceled',
    body: 'Hi {{1}}, your appointment with {{2}} on {{3}} at {{4}} was canceled.',
    footer: 'Reply for help',
    bodyParams: ['John', 'Fashion Styles', 'December 31, 2025', '1:00 PM'],
  };

  const customizedDto: CreateTemplateFromLibraryInput = {
    ...baseDto,
    customization: {
      parameterFormat: 'POSITIONAL',
      body: {
        text: 'Hello {{1}},\n\nYour upcoming appointment with {{2}} on {{3}} at {{4}} has been canceled.\n\nLet us know if you have any questions or need to reschedule.\n\n',
        variables: ['John', 'Fashion Styles', 'December 31, 2025', '1:00 PM'],
      },
    },
    parameterFormat: 'POSITIONAL',
    bodyInputs: {
      '1': 'John',
      '2': 'Fashion Styles',
      '3': 'December 31, 2025',
      '4': '1:00 PM',
    },
    allowCategoryChange: true,
  };

  it('uses library_copy mode without customization', () => {
    expect(resolveCustomizationMode(baseDto, preview)).toBe('library_copy');
    const payload = buildLibraryTemplateMetaPayload(baseDto, 'en_US', preview);
    expect(payload.library_template_name).toBe('appointment_cancellation_1');
    expect(payload.components).toBeUndefined();
  });

  it('uses full_template mode when body text is customized (user regression)', () => {
    expect(resolveCustomizationMode(customizedDto, preview)).toBe('full_template');

    const payload = buildLibraryTemplateMetaPayload(customizedDto, 'en_US', preview);

    expect(payload.library_template_name).toBeUndefined();
    expect(payload.parameter_format).toBe('POSITIONAL');
    expect(payload.allow_category_change).toBe(true);

    const components = payload.components as Record<string, unknown>[];
    const body = components.find(c => c.type === 'BODY');
    expect(body?.text).toContain('Your upcoming appointment with {{2}}');
    expect(body?.example).toEqual({
      body_text: [['John', 'Fashion Styles', 'December 31, 2025', '1:00 PM']],
    });
  });

  it('uses library_variables mode when only sample values change', () => {
    const dto: CreateTemplateFromLibraryInput = {
      ...baseDto,
      customization: {
        body: {
          variables: ['John', 'Fashion Styles', 'December 31, 2025', '1:00 PM'],
        },
      },
    };

    expect(resolveCustomizationMode(dto, preview)).toBe('library_variables');

    const payload = buildLibraryTemplateMetaPayload(dto, 'en_US', preview);
    expect(payload.library_template_name).toBe('appointment_cancellation_1');
    expect(payload.components).toBeUndefined();
    expect(payload.library_template_body_inputs).toEqual({
      '1': 'John',
      '2': 'Fashion Styles',
      '3': 'December 31, 2025',
      '4': '1:00 PM',
    });
  });

  it('normalizes button inputs on library copy without components', () => {
    const payload = buildLibraryTemplateMetaPayload(
      {
        ...baseDto,
        customization: {
          buttons: [
            {
              type: 'URL',
              url: {
                baseUrl: 'https://acme.com/{{1}}',
                urlSuffixExample: 'https://acme.com/deposit',
              },
            },
          ],
        },
      },
      'en_US',
      preview,
    );

    expect(payload.components).toBeUndefined();
    expect(payload.library_template_button_inputs).toEqual([
      {
        type: 'URL',
        url: {
          base_url: 'https://acme.com/{{1}}',
          url_suffix_example: 'https://acme.com/deposit',
        },
      },
    ]);
  });
});
