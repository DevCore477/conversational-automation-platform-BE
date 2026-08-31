import type { WhatsAppMessageDesign } from '../types/message-design.types';
import { renderPlaceholders } from './placeholder.util';

export { renderPlaceholders, extractPlaceholderKeys, findMissingPlaceholderKeys } from './placeholder.util';

export function applyVariablesToDesign(
  design: WhatsAppMessageDesign,
  variables: Record<string, string> | undefined,
): WhatsAppMessageDesign {
  if (!variables) {
    return design;
  }

  switch (design.type) {
    case 'text':
      return { ...design, body: renderPlaceholders(design.body, variables) };
    case 'template': {
      const parameters =
        design.parameters?.map(p => renderPlaceholders(p, variables)) ??
        Object.keys(variables)
          .sort((a, b) => {
            const na = Number(a);
            const nb = Number(b);
            if (!Number.isNaN(na) && !Number.isNaN(nb)) {
              return na - nb;
            }
            return a.localeCompare(b);
          })
          .map(k => String(variables[k]));
      return { ...design, parameters };
    }
    case 'media':
      return {
        ...design,
        caption: design.caption
          ? renderPlaceholders(design.caption, variables)
          : undefined,
      };
    case 'interactive_buttons':
      return { ...design, body: renderPlaceholders(design.body, variables) };
    case 'interactive_list':
      return { ...design, body: renderPlaceholders(design.body, variables) };
    default:
      return design;
  }
}

export function buildMetaPayload(
  design: WhatsAppMessageDesign,
  recipientDigits: string,
): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', to: recipientDigits };

  switch (design.type) {
    case 'text':
      return {
        ...base,
        type: 'text',
        text: { body: design.body, preview_url: design.previewUrl ?? false },
      };
    case 'template': {
      const parameters = design.parameters ?? [];
      const components =
        parameters.length > 0
          ? [
              {
                type: 'body',
                parameters: parameters.map(text => ({ type: 'text', text })),
              },
            ]
          : undefined;
      return {
        ...base,
        type: 'template',
        template: {
          name: design.templateName,
          language: { code: design.languageCode ?? 'en' },
          components,
        },
      };
    }
    case 'media': {
      const mediaPayload: Record<string, unknown> = { link: design.url };
      if (design.caption) {
        mediaPayload.caption = design.caption;
      }
      return {
        ...base,
        type: design.mediaType,
        [design.mediaType]: mediaPayload,
      };
    }
    case 'interactive_buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(design.header ? { header: design.header } : {}),
          body: { text: design.body },
          ...(design.footer ? { footer: design.footer } : {}),
          action: {
            buttons: design.buttons.map(b => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    case 'interactive_list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: design.body },
          ...(design.footer ? { footer: design.footer } : {}),
          action: {
            button: design.buttonText,
            sections: design.sections.map(s => ({
              title: s.title,
              rows: s.rows.map(r => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            })),
          },
        },
      };
    default:
      return base;
  }
}

export function designPreviewText(design: WhatsAppMessageDesign): string {
  switch (design.type) {
    case 'text':
      return design.body;
    case 'template':
      return `[Template: ${design.templateName}] ${(design.parameters ?? []).join(' | ')}`;
    case 'media':
      return `[${design.mediaType}] ${design.url}${design.caption ? ` — ${design.caption}` : ''}`;
    case 'interactive_buttons':
      return `${design.body}\n[Buttons: ${design.buttons.map(b => b.title).join(', ')}]`;
    case 'interactive_list':
      return `${design.body}\n[List: ${design.sections.flatMap(s => s.rows.map(r => r.title)).join(', ')}]`;
    default:
      return '';
  }
}
