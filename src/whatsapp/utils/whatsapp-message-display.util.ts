import {
  extractNamedBodyParamNames,
  formatTemplatePreviewBody,
  lookupContentVariable,
} from './whatsapp-template-send.util';

export interface TemplateSendVarsPayload {
  parameters?: string[];
  contentVariables?: Record<string, string>;
}

export interface TemplateMessagePayload {
  templateId?: string;
  templateSendVars?: TemplateSendVarsPayload;
}

export interface TemplateDisplayInfo {
  id?: string | null;
  name: string;
  metaTemplateName: string;
  bodyPreview: string | null;
  language?: string | null;
  category?: string | null;
}

const TEMPLATE_PLACEHOLDER_RE = /^\[template:(.+)\]$/i;

export function isTemplatePlaceholderBody(body: string | null | undefined): boolean {
  return Boolean(body && TEMPLATE_PLACEHOLDER_RE.test(body.trim()));
}

export function extractTemplateSendVarsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): TemplateSendVarsPayload | undefined {
  if (!payload) {
    return undefined;
  }
  const raw = payload.templateSendVars;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const vars = raw as TemplateSendVarsPayload;
  if (vars.parameters?.length || vars.contentVariables) {
    return vars;
  }
  return undefined;
}

export function buildTemplateMessagePreview(
  bodyPreview: string | null | undefined,
  sendVars: TemplateSendVarsPayload | undefined,
  templateName?: string | null,
): string {
  const named = sendVars?.contentVariables;
  const positional = sendVars?.parameters ?? [];

  if (bodyPreview?.trim()) {
    if (named && Object.keys(named).length > 0) {
      return formatTemplatePreviewBody(bodyPreview, [], named);
    }
    if (positional.length > 0) {
      return formatTemplatePreviewBody(bodyPreview, positional);
    }
    return bodyPreview;
  }

  if (named && Object.keys(named).length > 0) {
    return Object.values(named).join(' | ');
  }
  if (positional.length > 0) {
    return positional.join(' | ');
  }

  return templateName ? `Template: ${templateName}` : 'Template message';
}

export function resolveMessageDisplayBody(
  body: string | null | undefined,
  template: TemplateDisplayInfo | null | undefined,
  sendVars?: TemplateSendVarsPayload,
): string {
  if (!isTemplatePlaceholderBody(body) && body?.trim()) {
    return body;
  }

  return buildTemplateMessagePreview(
    template?.bodyPreview,
    sendVars,
    template?.metaTemplateName ?? template?.name ?? null,
  );
}

export function extractPositionalPlaceholderNames(text: string | null | undefined): string[] {
  if (!text?.trim()) {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{\{(\d+)\}\}/g)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names.sort((a, b) => Number(a) - Number(b));
}

/** Ordered placeholder slot names from synced template components / body preview. */
export function extractTemplatePlaceholderNames(
  components?: Record<string, unknown>[] | null,
  bodyPreview?: string | null,
): string[] {
  const named = extractNamedBodyParamNames(components);
  if (named.length > 0) {
    return named;
  }

  const bodyText =
    bodyPreview ??
    (components?.find(c => String(c.type).toUpperCase() === 'BODY')?.text as string | undefined);
  return extractPositionalPlaceholderNames(bodyText);
}

/**
 * Ordered parameter values actually sent with a template message.
 * Positional sends return the parameters array; named sends return values in template order.
 */
export function extractMessageTemplateParameterValues(
  sendVars?: TemplateSendVarsPayload,
  templateOrderHint?: string[],
): string[] {
  if (!sendVars) {
    return [];
  }

  if (sendVars.parameters?.length) {
    return sendVars.parameters;
  }

  const named = sendVars.contentVariables;
  if (!named || Object.keys(named).length === 0) {
    return [];
  }

  if (templateOrderHint?.length) {
    return templateOrderHint.flatMap(name => {
      const value = lookupContentVariable(named, name);
      return value != null ? [value] : [];
    });
  }

  return Object.values(named);
}

export function toTemplateDisplayInfo(template: {
  id?: string;
  name: string;
  metaTemplateName: string;
  bodyPreview?: string | null;
  language?: string | null;
  category?: string | null;
  components?: Record<string, unknown>[] | null;
}): TemplateDisplayInfo {
  return {
    id: template.id ?? null,
    name: template.name,
    metaTemplateName: template.metaTemplateName,
    bodyPreview: template.bodyPreview ?? null,
    language: template.language ?? null,
    category: template.category ?? null,
  };
}
