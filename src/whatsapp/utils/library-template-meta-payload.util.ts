import type { CreateTemplateFromLibraryInput } from '../dto/create-template-from-library.dto';

type MetaComponent = Record<string, unknown>;

export type LibraryTemplateCreateMode = 'library_copy' | 'library_variables' | 'full_template';

export interface LibraryTemplatePreview {
  header?: string;
  body?: string;
  footer?: string;
  bodyParams?: string[];
  buttons?: unknown[];
}

export function hasExplicitTemplateCustomization(dto: CreateTemplateFromLibraryInput): boolean {
  const c = dto.customization;
  if (c?.components?.length) {
    return true;
  }
  if (c?.header && Object.keys(c.header).length > 0) {
    return true;
  }
  if (c?.body?.text?.trim()) {
    return true;
  }
  if (c?.body?.variables?.length) {
    return true;
  }
  if (c?.body?.namedVariables?.length) {
    return true;
  }
  if (c?.footer?.text?.trim()) {
    return true;
  }
  if (dto.bodyInputs && Object.keys(dto.bodyInputs).length > 0) {
    return true;
  }
  return false;
}

/**
 * Meta library copy only supports filling parameters on fixed library text.
 * Custom header/body/footer text → standard template create (components, no library_template_name).
 */
export function resolveCustomizationMode(
  dto: CreateTemplateFromLibraryInput,
  preview?: LibraryTemplatePreview | null,
): LibraryTemplateCreateMode {
  if (!hasExplicitTemplateCustomization(dto)) {
    return 'library_copy';
  }

  const c = dto.customization;
  if (c?.components?.length) {
    return 'full_template';
  }

  const previewBody = preview?.body?.trim();
  const customBody = c?.body?.text?.trim() ?? '';
  const bodyTextChanged =
    customBody.length > 0 &&
    (!previewBody || normalizeTemplateText(customBody) !== normalizeTemplateText(previewBody));

  const headerChanged = Boolean(c?.header?.text?.trim());
  const footerChanged = Boolean(c?.footer?.text?.trim());
  const hasNamedVariables = Boolean(c?.body?.namedVariables?.length);

  if (bodyTextChanged || headerChanged || footerChanged || hasNamedVariables) {
    return 'full_template';
  }

  return 'library_variables';
}

/** Build Meta POST /message_templates body for create-from-library. */
export function buildLibraryTemplateMetaPayload(
  dto: CreateTemplateFromLibraryInput,
  metaLanguage: string,
  preview?: LibraryTemplatePreview | null,
): Record<string, unknown> {
  const mode = resolveCustomizationMode(dto, preview);
  const parameterFormat = dto.customization?.parameterFormat ?? dto.parameterFormat;

  const payload: Record<string, unknown> = {
    name: dto.name.trim().toLowerCase(),
    language: metaLanguage,
    category: dto.category.toUpperCase(),
  };

  if (dto.allowCategoryChange === true) {
    payload.allow_category_change = true;
  }
  if (parameterFormat) {
    payload.parameter_format = parameterFormat;
  }

  if (mode === 'full_template') {
    payload.components = buildFullTemplateComponents(dto, preview, parameterFormat);
    return payload;
  }

  payload.library_template_name = dto.libraryTemplateName;

  const bodyInputs = buildLibraryVariableBodyInputs(dto);
  const flagInputs = buildLibraryTemplateFlagInputs(dto);
  const libraryBodyInputs = { ...bodyInputs, ...flagInputs };
  if (Object.keys(libraryBodyInputs).length > 0) {
    payload.library_template_body_inputs = libraryBodyInputs;
  }

  const buttonInputs = buildLibraryTemplateButtonInputs(dto);
  if (buttonInputs.length > 0) {
    payload.library_template_button_inputs = buttonInputs;
  }

  return payload;
}

export function buildLibraryTemplatePreview(
  row:
    | {
        header?: string;
        body?: string;
        footer?: string;
        body_params?: unknown[];
        buttons?: unknown[];
      }
    | null
    | undefined,
): LibraryTemplatePreview | null {
  if (!row) {
    return null;
  }
  return {
    header: typeof row.header === 'string' ? row.header : undefined,
    body: typeof row.body === 'string' ? row.body : undefined,
    footer: typeof row.footer === 'string' ? row.footer : undefined,
    bodyParams: Array.isArray(row.body_params) ? row.body_params.map(v => String(v)) : undefined,
    buttons: Array.isArray(row.buttons) ? row.buttons : undefined,
  };
}

function buildFullTemplateComponents(
  dto: CreateTemplateFromLibraryInput,
  preview: LibraryTemplatePreview | null | undefined,
  parameterFormat?: 'POSITIONAL' | 'NAMED',
): MetaComponent[] {
  if (dto.customization?.components?.length) {
    return dto.customization.components.map(normalizeComponent);
  }

  const components: MetaComponent[] = [];
  const custom = dto.customization;
  const format =
    parameterFormat ??
    custom?.parameterFormat ??
    dto.parameterFormat ??
    (custom?.body?.namedVariables?.length ? 'NAMED' : 'POSITIONAL');

  const header = buildHeaderComponent(custom?.header, preview?.header);
  if (header) {
    components.push(header);
  }

  const body = buildBodyComponent(
    custom?.body,
    preview?.body,
    collectBodyVariableValues(dto),
    format,
    true,
  );
  if (body) {
    components.push(body);
  }

  const footer = buildFooterComponent(custom?.footer, preview?.footer);
  if (footer) {
    components.push(footer);
  }

  const buttonsComponent =
    buildButtonsComponentFromCustomization(dto) ?? buildButtonsComponentFromPreview(preview?.buttons);
  if (buttonsComponent) {
    components.push(buttonsComponent);
  }

  return components;
}

function buildLibraryVariableBodyInputs(dto: CreateTemplateFromLibraryInput): Record<string, string> {
  const values = collectBodyVariableValues(dto);
  if (!values?.length) {
    return {};
  }
  const out: Record<string, string> = {};
  values.forEach((value, index) => {
    out[String(index + 1)] = value;
  });
  return out;
}

function buildLibraryTemplateFlagInputs(
  dto: CreateTemplateFromLibraryInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const flags = dto.customization?.flags;

  if (flags?.addContactNumber === true) {
    out.add_contact_number = true;
  }
  if (flags?.addLearnMoreLink === true) {
    out.add_learn_more_link = true;
  }
  if (flags?.addSecurityRecommendation === true) {
    out.add_security_recommendation = true;
  }
  if (flags?.addTrackPackageLink === true) {
    out.add_track_package_link = true;
  }
  if (flags?.codeExpirationMinutes != null) {
    out.code_expiration_minutes = flags.codeExpirationMinutes;
  }

  if (dto.bodyInputs) {
    for (const [key, value] of Object.entries(dto.bodyInputs)) {
      if (isMetaBodyInputFlag(key)) {
        out[toSnakeCase(key)] = value;
      }
    }
  }

  return out;
}

function buildLibraryTemplateButtonInputs(
  dto: CreateTemplateFromLibraryInput,
): Record<string, unknown>[] {
  const raw = dto.customization?.buttons ?? dto.buttonInputs ?? [];
  return raw.map(btn => normalizeButtonInput(btn));
}

type HeaderCustomization = NonNullable<
  NonNullable<CreateTemplateFromLibraryInput['customization']>['header']
>;
type BodyCustomization = NonNullable<
  NonNullable<CreateTemplateFromLibraryInput['customization']>['body']
>;
type FooterCustomization = NonNullable<
  NonNullable<CreateTemplateFromLibraryInput['customization']>['footer']
>;

function buildHeaderComponent(
  header: HeaderCustomization | undefined,
  previewText?: string,
): MetaComponent | null {
  if (!header && !previewText?.trim()) {
    return null;
  }

  const text = header?.text?.trim() || previewText?.trim();
  if (!text && !header?.mediaHandle && !header?.variables?.length && !header?.namedVariables?.length) {
    return null;
  }

  const component: MetaComponent = {
    type: 'HEADER',
    format: (header?.format ?? inferHeaderFormat(text, header?.mediaHandle)).toUpperCase(),
  };

  if (text) {
    component.text = text;
  }

  const example: Record<string, unknown> = {};
  if (header?.mediaHandle) {
    example.header_handle = [header.mediaHandle];
  }
  if (header?.namedVariables?.length) {
    example.header_text_named_params = header.namedVariables.map(v => ({
      param_name: v.name,
      example: v.example,
    }));
  } else if (header?.variables?.length) {
    example.header_text = header.variables;
  }
  if (Object.keys(example).length > 0) {
    component.example = example;
  }

  return component;
}

function buildBodyComponent(
  body: BodyCustomization | undefined,
  previewText: string | undefined,
  variableValues: string[] | undefined,
  parameterFormat: 'POSITIONAL' | 'NAMED' | undefined,
  requireText: boolean,
): MetaComponent | null {
  const text = body?.text?.trim() || previewText?.trim();
  const variables = body?.variables ?? variableValues;

  if (!text) {
    if (requireText) {
      return null;
    }
    if (!variables?.length && !body?.namedVariables?.length) {
      return null;
    }
  }

  const component: MetaComponent = { type: 'BODY' };
  if (text) {
    component.text = text;
  }

  const format =
    parameterFormat ?? (body?.namedVariables?.length ? 'NAMED' : 'POSITIONAL');
  const example = buildExampleBlock({
    variables,
    namedVariables: body?.namedVariables,
    parameterFormat: format,
  });
  if (example) {
    component.example = example;
  }

  return component;
}

function buildFooterComponent(
  footer: FooterCustomization | undefined,
  previewText?: string,
): MetaComponent | null {
  const text = footer?.text?.trim() || previewText?.trim();
  if (!text) {
    return null;
  }
  return { type: 'FOOTER', text };
}

function buildButtonsComponentFromCustomization(
  dto: CreateTemplateFromLibraryInput,
): MetaComponent | null {
  const buttons = dto.customization?.buttons ?? dto.buttonInputs;
  if (!buttons?.length) {
    return null;
  }
  return { type: 'BUTTONS', buttons: buttons.map(normalizeButtonInput) };
}

function buildButtonsComponentFromPreview(buttons: unknown[] | undefined): MetaComponent | null {
  if (!buttons?.length) {
    return null;
  }
  const normalized = buttons
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .map(normalizeLibraryPreviewButton)
    .filter(btn => Object.keys(btn).length > 0);
  if (!normalized.length) {
    return null;
  }
  return { type: 'BUTTONS', buttons: normalized };
}

function buildExampleBlock(params: {
  variables?: string[];
  namedVariables?: { name: string; example: string }[];
  parameterFormat?: 'POSITIONAL' | 'NAMED';
}): Record<string, unknown> | null {
  const example: Record<string, unknown> = {};

  if (params.namedVariables?.length && params.parameterFormat === 'NAMED') {
    example.body_text_named_params = params.namedVariables.map(v => ({
      param_name: v.name,
      example: v.example,
    }));
  } else if (params.variables?.length) {
    example.body_text = [params.variables];
  }

  return Object.keys(example).length > 0 ? example : null;
}

function collectBodyVariableValues(dto: CreateTemplateFromLibraryInput): string[] | undefined {
  if (dto.customization?.body?.variables?.length) {
    return dto.customization.body.variables;
  }
  if (dto.customization?.body?.namedVariables?.length) {
    return dto.customization.body.namedVariables.map(v => v.example);
  }
  if (dto.bodyInputs && Object.keys(dto.bodyInputs).length > 0) {
    const entries = Object.entries(dto.bodyInputs).filter(([key]) => !isMetaBodyInputFlag(key));
    if (entries.length === 0) {
      return undefined;
    }
    const numeric = entries.every(([key]) => /^\d+$/.test(key));
    if (numeric) {
      return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => String(value));
    }
    return entries.map(([, value]) => String(value));
  }
  return undefined;
}

function normalizeComponent(component: Record<string, unknown>): MetaComponent {
  const out: MetaComponent = { ...component };
  if (typeof out.type === 'string') {
    out.type = out.type.toUpperCase();
  }
  if (typeof out.format === 'string') {
    out.format = out.format.toUpperCase();
  }
  return out;
}

function normalizeButtonInput(btn: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = String(btn.type ?? btn.Type ?? '').toUpperCase();
  if (type) {
    out.type = type;
  }

  if (btn.text != null) {
    out.text = btn.text;
  }
  if (btn.phone_number != null || btn.phoneNumber != null) {
    out.phone_number = btn.phone_number ?? btn.phoneNumber;
  }

  const url = (btn.url ?? btn.URL) as Record<string, unknown> | string | undefined;
  if (url && typeof url === 'object') {
    out.url = {
      base_url: url.base_url ?? url.baseUrl,
      url_suffix_example: url.url_suffix_example ?? url.urlSuffixExample,
    };
  } else if (typeof url === 'string') {
    out.url = url;
  }

  if (btn.otp_type != null || btn.otpType != null) {
    out.otp_type = btn.otp_type ?? btn.otpType;
  }
  if (btn.zero_tap_terms_accepted != null || btn.zeroTapTermsAccepted != null) {
    out.zero_tap_terms_accepted = btn.zero_tap_terms_accepted ?? btn.zeroTapTermsAccepted;
  }
  if (btn.supported_apps != null || btn.supportedApps != null) {
    out.supported_apps = btn.supported_apps ?? btn.supportedApps;
  }

  return out;
}

function normalizeLibraryPreviewButton(btn: Record<string, unknown>): Record<string, unknown> {
  const type = String(btn.type ?? '').toUpperCase();
  const out: Record<string, unknown> = { type };
  if (btn.text != null) {
    out.text = btn.text;
  }
  if (type === 'PHONE_NUMBER' && btn.phone_number != null) {
    out.phone_number = btn.phone_number;
  }
  if (type === 'URL' && typeof btn.url === 'string') {
    out.url = btn.url;
  }
  return out;
}

function inferHeaderFormat(text?: string, mediaHandle?: string): string {
  if (mediaHandle) {
    return 'IMAGE';
  }
  return text ? 'TEXT' : 'TEXT';
}

function normalizeTemplateText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isMetaBodyInputFlag(key: string): boolean {
  const normalized = key.toLowerCase().replace(/_/g, '');
  return [
    'addcontactnumber',
    'addlearnmorelink',
    'addsecurityrecommendation',
    'addtrackpackagelink',
    'codeexpirationminutes',
  ].includes(normalized);
}

function toSnakeCase(key: string): string {
  return key
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_/, '')
    .toLowerCase();
}

export function deriveBodyPreviewFromPayload(
  payload: Record<string, unknown>,
  preview?: LibraryTemplatePreview | null,
): string | null {
  const components = payload.components as MetaComponent[] | undefined;
  if (components?.length) {
    const body = components.find(c => String(c.type).toUpperCase() === 'BODY');
    if (typeof body?.text === 'string') {
      return body.text;
    }
  }
  return preview?.body ?? null;
}

export function deriveComponentsFromPayload(
  payload: Record<string, unknown>,
): Record<string, unknown>[] | null {
  const components = payload.components as MetaComponent[] | undefined;
  return components?.length ? components : null;
}
