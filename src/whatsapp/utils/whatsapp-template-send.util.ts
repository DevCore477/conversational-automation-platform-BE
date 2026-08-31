export interface TemplateSendParameter {
  type?: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
  text?: string;
}

export interface TemplateButtonSendInput {
  index?: number;
  subType?: 'url' | 'quick_reply';
  parameters: string[];
}

export interface TemplateComponentSendInput {
  type: 'header' | 'body' | 'button';
  subType?: 'url' | 'quick_reply';
  index?: number;
  parameters?: (string | TemplateSendParameter)[];
}

export interface BuildTemplateSendComponentsInput {
  components?: TemplateComponentSendInput[];
  headerParameters?: string[];
  bodyParameters?: string[];
  parameters?: string[];
  contentVariables?: Record<string, string>;
  buttonParameters?: TemplateButtonSendInput[];
  /** Stored Meta template components — used to detect named vs positional variables. */
  templateComponents?: Record<string, unknown>[] | null;
  bodyPreview?: string | null;
}

export class TemplateVariableError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing template variables: ${missing.join(', ')}`);
    this.name = 'TemplateVariableError';
  }
}

/** Build Meta Cloud API template.components for a send request. */
export function buildTemplateSendComponents(
  input: BuildTemplateSendComponentsInput,
): Record<string, unknown>[] | undefined {
  if (input.components?.length) {
    const built = input.components
      .map(normalizeExplicitComponent)
      .filter(c => (c.parameters as unknown[])?.length > 0);
    return built.length > 0 ? built : undefined;
  }

  const components: Record<string, unknown>[] = [];

  if (input.headerParameters?.length) {
    components.push({
      type: 'header',
      parameters: input.headerParameters.map(text => ({ type: 'text', text })),
    });
  }

  const namedParamNames = resolveNamedBodyParamNames(
    input.templateComponents,
    input.bodyPreview,
    input.contentVariables,
  );

  if (namedParamNames.length > 0 && input.contentVariables) {
    components.push({
      type: 'body',
      parameters: buildNamedBodyParameters(input.contentVariables, namedParamNames),
    });
  } else {
    const bodyValues =
      input.bodyParameters ??
      input.parameters ??
      orderedTemplateValues(input.contentVariables);

    if (bodyValues.length > 0) {
      components.push({
        type: 'body',
        parameters: bodyValues.map(text => ({ type: 'text', text })),
      });
    }
  }

  for (const button of input.buttonParameters ?? []) {
    if (!button.parameters?.length) {
      continue;
    }
    components.push({
      type: 'button',
      sub_type: button.subType ?? 'url',
      index: String(button.index ?? 0),
      parameters: button.parameters.map(text => ({ type: 'text', text })),
    });
  }

  return components.length > 0 ? components : undefined;
}

/** Named placeholders from synced template components (e.g. body_text_named_params). */
export function extractNamedBodyParamNames(
  components: Record<string, unknown>[] | null | undefined,
): string[] {
  if (!components?.length) {
    return [];
  }
  const body = components.find(c => String(c.type).toUpperCase() === 'BODY');
  if (!body) {
    return [];
  }
  const example = body.example as Record<string, unknown> | undefined;
  const named = example?.body_text_named_params as { param_name?: string }[] | undefined;
  if (named?.length) {
    return named.map(p => p.param_name).filter((n): n is string => Boolean(n));
  }
  const text = typeof body.text === 'string' ? body.text : '';
  return extractNamedPlaceholdersFromText(text);
}

export function extractNamedPlaceholdersFromText(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function isNamedContentVariables(vars: Record<string, string>): boolean {
  return Object.keys(vars).some(k => Number.isNaN(Number(k)));
}

export function lookupContentVariable(
  vars: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!vars) {
    return undefined;
  }
  if (vars[name] != null) {
    return vars[name];
  }
  const lower = name.toLowerCase();
  const key = Object.keys(vars).find(k => k.toLowerCase() === lower);
  if (key) {
    return vars[key];
  }
  const compact = lower.replace(/_/g, '');
  const fuzzyKey = Object.keys(vars).find(k => k.toLowerCase().replace(/_/g, '') === compact);
  return fuzzyKey ? vars[fuzzyKey] : undefined;
}

export interface CampaignTemplateSendVars {
  parameters?: string[];
  contentVariables?: Record<string, string>;
}

/** Map CSV / campaign recipient fields to Meta positional or named template variables. */
export function resolveCampaignTemplateSendVars(
  recipient: { templateParams?: string[]; variables?: Record<string, string> } | undefined,
  namedParamNames: string[],
): CampaignTemplateSendVars {
  if (!recipient) {
    return {};
  }

  const variables = recipient.variables ?? {};

  if (namedParamNames.length > 0) {
    const contentVariables: Record<string, string> = {};

    for (const paramName of namedParamNames) {
      const value = lookupContentVariable(variables, paramName);
      if (value != null) {
        contentVariables[paramName] = value;
      }
    }

    if (recipient.templateParams?.length) {
      for (let i = 0; i < namedParamNames.length; i++) {
        const paramName = namedParamNames[i];
        if (contentVariables[paramName] == null && recipient.templateParams[i] != null) {
          contentVariables[paramName] = recipient.templateParams[i];
        }
      }
    }

    if (Object.keys(contentVariables).length > 0) {
      return { contentVariables };
    }
    return {};
  }

  if (recipient.templateParams?.length) {
    return { parameters: recipient.templateParams };
  }

  const paramKeys = Object.keys(variables)
    .filter(k => /^param\d+$/i.test(k))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));

  if (paramKeys.length > 0) {
    return { parameters: paramKeys.map(k => variables[k]) };
  }

  return {};
}

export function buildNamedBodyParameters(
  vars: Record<string, string>,
  paramNames: string[],
): Array<{ type: 'text'; parameter_name: string; text: string }> {
  const missing: string[] = [];
  const parameters = paramNames.map(name => {
    const text = lookupContentVariable(vars, name);
    if (text == null) {
      missing.push(name);
      return null;
    }
    return { type: 'text' as const, parameter_name: name, text };
  });

  if (missing.length > 0) {
    throw new TemplateVariableError(missing);
  }

  return parameters.filter((p): p is { type: 'text'; parameter_name: string; text: string } =>
    Boolean(p),
  );
}

function resolveNamedBodyParamNames(
  templateComponents: Record<string, unknown>[] | null | undefined,
  bodyPreview: string | null | undefined,
  contentVariables: Record<string, string> | undefined,
): string[] {
  const fromComponents = extractNamedBodyParamNames(templateComponents);
  if (fromComponents.length > 0) {
    return fromComponents;
  }
  if (!contentVariables || !isNamedContentVariables(contentVariables)) {
    return [];
  }
  const fromPreview = bodyPreview ? extractNamedPlaceholdersFromText(bodyPreview) : [];
  if (fromPreview.length > 0) {
    return fromPreview;
  }
  return Object.keys(contentVariables);
}

export function orderedTemplateValues(vars: Record<string, string> | undefined): string[] {
  if (!vars || Object.keys(vars).length === 0) {
    return [];
  }
  const keys = Object.keys(vars).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      return na - nb;
    }
    return a.localeCompare(b);
  });
  return keys.map(k => vars[k]);
}

export function formatTemplatePreviewBody(
  bodyTemplate: string | null | undefined,
  bodyParameters: string[],
  namedVariables?: Record<string, string>,
): string {
  if (!bodyTemplate?.trim()) {
    if (namedVariables && Object.keys(namedVariables).length > 0) {
      return Object.values(namedVariables).join(' | ');
    }
    if (bodyParameters.length === 0) {
      return '';
    }
    return bodyParameters.join(' | ');
  }
  if (namedVariables && Object.keys(namedVariables).length > 0) {
    return bodyTemplate.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name: string) => {
      return lookupContentVariable(namedVariables, name) ?? `{{${name}}}`;
    });
  }
  return bodyTemplate.replace(/\{\{(\d+)\}\}/g, (_, index: string) => {
    const value = bodyParameters[Number(index) - 1];
    return value ?? `{{${index}}}`;
  });
}

function normalizeExplicitComponent(
  component: TemplateComponentSendInput,
): Record<string, unknown> {
  const type = component.type.toLowerCase();
  const out: Record<string, unknown> = {
    type,
    parameters: (component.parameters ?? []).map(normalizeParameter),
  };
  if (type === 'button') {
    out.sub_type = (component.subType ?? 'url').toLowerCase();
    out.index = String(component.index ?? 0);
  }
  return out;
}

function normalizeParameter(param: string | TemplateSendParameter): Record<string, unknown> {
  if (typeof param === 'string') {
    return { type: 'text', text: param };
  }
  return {
    type: param.type ?? 'text',
    ...(param.text != null ? { text: param.text } : {}),
  };
}
