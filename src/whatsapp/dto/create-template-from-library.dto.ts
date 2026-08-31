import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WHATSAPP_TEMPLATE_CATEGORIES } from '../../common/enums/whatsapp.enum';
import { optionalCoerceBoolean, optionalJsonRecord, trimmedString } from './zod-field.util';

const ButtonInputSchema = z.record(z.string(), z.unknown());

const NamedVariableSchema = z.object({
  name: trimmedString(1, 64),
  example: trimmedString(1, 1024),
});

const HeaderCustomizationSchema = z.object({
  format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).optional(),
  text: z.string().max(60).optional(),
  /** Positional sample values for {{1}}, {{2}}, … in the header. */
  variables: z.array(z.string().max(1024)).max(20).optional(),
  /** Named parameter samples when parameterFormat is NAMED. */
  namedVariables: z.array(NamedVariableSchema).max(20).optional(),
  /** Media handle from Meta Resumable Upload API (image/video/document headers). */
  mediaHandle: z.string().max(512).optional(),
});

const BodyCustomizationSchema = z.object({
  /** Override body text (must match library structure / variables). */
  text: z.string().max(1024).optional(),
  variables: z.array(z.string().max(1024)).max(30).optional(),
  namedVariables: z.array(NamedVariableSchema).max(30).optional(),
});

const FooterCustomizationSchema = z.object({
  text: z.string().max(60).optional(),
});

const BodyFlagsSchema = z.object({
  addContactNumber: optionalCoerceBoolean(),
  addLearnMoreLink: optionalCoerceBoolean(),
  addSecurityRecommendation: optionalCoerceBoolean(),
  addTrackPackageLink: optionalCoerceBoolean(),
  codeExpirationMinutes: z.coerce.number().int().min(1).max(90).optional(),
});

const TemplateCustomizationSchema = z.object({
  parameterFormat: z.enum(['POSITIONAL', 'NAMED']).optional(),
  header: HeaderCustomizationSchema.optional(),
  body: BodyCustomizationSchema.optional(),
  footer: FooterCustomizationSchema.optional(),
  flags: BodyFlagsSchema.optional(),
  buttons: z.array(ButtonInputSchema).max(10).optional(),
  /** Advanced: pass Meta components array directly (HEADER, BODY, FOOTER, BUTTONS). */
  components: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
});

const templateCategoryBody = z.preprocess(
  value => {
    if (typeof value === 'string') {
      const trimmed = value.trim().toUpperCase();
      return trimmed.length ? trimmed : value;
    }
    return value;
  },
  z.enum(WHATSAPP_TEMPLATE_CATEGORIES, {
    message: `category must be one of ${WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}`,
  }),
);

const templateNameBody = trimmedString(1, 128).pipe(
  z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'name must be lowercase snake_case (letters, numbers, underscores)',
    ),
);

export const CreateTemplateFromLibrarySchema = z.object({
  libraryTemplateName: trimmedString(1, 128),
  name: templateNameBody,
  language: z.preprocess(value => {
    if (typeof value === 'string') {
      const trimmed = value.trim().replace('-', '_');
      return trimmed.length ? trimmed : 'en_US';
    }
    return value ?? 'en_US';
  }, z.string().min(2, 'language is required').max(16)),
  category: templateCategoryBody,
  /** Structured customization — header, body, footer, variables, buttons (like Meta WAM). */
  customization: TemplateCustomizationSchema.optional(),
  parameterFormat: z.enum(['POSITIONAL', 'NAMED']).optional(),
  /** @deprecated Prefer customization.body.variables — positional {{1}}, {{2}} sample values. */
  bodyInputs: optionalJsonRecord(),
  /** @deprecated Prefer customization.buttons */
  buttonInputs: z.preprocess(value => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return value;
  }, z.array(ButtonInputSchema).optional()),
  allowCategoryChange: optionalCoerceBoolean(),
});

export class CreateTemplateFromLibraryDto extends createZodDto(CreateTemplateFromLibrarySchema) {}

export type CreateTemplateFromLibraryInput = z.infer<typeof CreateTemplateFromLibrarySchema>;
