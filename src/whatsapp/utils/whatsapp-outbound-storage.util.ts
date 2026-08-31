import type { WhatsAppMessageDesign } from '../types/message-design.types';
import { applyVariablesToDesign, designPreviewText } from './message-builder.util';
import {
  buildTemplateMessagePreview,
  type TemplateSendVarsPayload,
} from './whatsapp-message-display.util';

export interface OutboundMessageStorage {
  body: string;
  templateName?: string | null;
  payload?: Record<string, unknown> | null;
}

export function buildTemplateOutboundStorage(params: {
  templateName: string;
  templateId?: string;
  bodyPreview?: string | null;
  sendVars?: TemplateSendVarsPayload;
}): OutboundMessageStorage {
  const sendVars = params.sendVars ?? {};
  return {
    body: buildTemplateMessagePreview(params.bodyPreview, sendVars, params.templateName),
    templateName: params.templateName,
    payload: {
      templateId: params.templateId,
      templateSendVars: sendVars,
    },
  };
}

export function resolveDesignOutboundStorage(
  design: WhatsAppMessageDesign,
  variables?: Record<string, string>,
  templateMeta?: {
    templateId?: string;
    bodyPreview?: string | null;
  } | null,
): OutboundMessageStorage {
  const resolved = variables ? applyVariablesToDesign(design, variables) : design;

  if (resolved.type === 'template') {
    const sendVars: TemplateSendVarsPayload = {
      parameters: resolved.parameters,
    };
    return buildTemplateOutboundStorage({
      templateName: resolved.templateName,
      templateId: templateMeta?.templateId,
      bodyPreview: templateMeta?.bodyPreview,
      sendVars,
    });
  }

  return {
    body: designPreviewText(resolved),
    templateName: null,
    payload: null,
  };
}
