import { WHATSAPP_TEMPLATE_USABLE_STATUSES } from '../../common/enums/whatsapp.enum';
import { WhatsAppTemplate } from '../../models/whatsapp/whatsapp-template.entity';

export interface WhatsAppTemplateResponse {
  id: string;
  companyId: string;
  name: string;
  metaTemplateName: string;
  metaTemplateId: string | null;
  category: string | null;
  language: string;
  status: string;
  qualityStatus: string | null;
  source: string;
  libraryTemplateName: string | null;
  rejectionReason: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  components: Record<string, unknown>[] | null;
  bodyPreview: string | null;
  usableForCampaigns: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplateSyncResult {
  synced: number;
  created: number;
  updated: number;
  archived: number;
  templates: WhatsAppTemplateResponse[];
}

export function templateToResponse(row: WhatsAppTemplate): WhatsAppTemplateResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    metaTemplateName: row.metaTemplateName,
    metaTemplateId: row.metaTemplateId,
    category: row.category,
    language: row.language,
    status: row.status,
    qualityStatus: row.qualityStatus ?? null,
    source: row.source ?? 'synced',
    libraryTemplateName: row.libraryTemplateName ?? null,
    rejectionReason: row.rejectionReason ?? null,
    isActive: row.isActive !== false,
    lastSyncedAt: row.lastSyncedAt ?? null,
    components: row.components,
    bodyPreview: row.bodyPreview,
    usableForCampaigns: WHATSAPP_TEMPLATE_USABLE_STATUSES.has(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function normalizeTemplateLanguage(lang: string): string {
  if (!lang) {
    return 'en';
  }
  return lang.replace('-', '_').toLowerCase();
}

/** Language code as required by Meta Graph (e.g. en_US, not en_us). */
export function toMetaLanguageCode(lang: string): string {
  if (!lang?.trim()) {
    return 'en_US';
  }
  const parts = lang.trim().replace('-', '_').split('_');
  if (parts.length === 1) {
    const code = parts[0].toLowerCase();
    if (code === 'en') {
      return 'en_US';
    }
    return code;
  }
  return `${parts[0].toLowerCase()}_${parts.slice(1).join('_').toUpperCase()}`;
}

export function humanizeTemplateName(metaName: string): string {
  return metaName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function extractBodyPreview(
  components?: Record<string, unknown>[] | null,
): string | null {
  if (!components?.length) {
    return null;
  }
  for (const comp of components) {
    if (comp.type === 'BODY' && typeof comp.text === 'string') {
      return comp.text;
    }
    if (comp.type === 'body' && typeof comp.text === 'string') {
      return comp.text;
    }
  }
  return null;
}
