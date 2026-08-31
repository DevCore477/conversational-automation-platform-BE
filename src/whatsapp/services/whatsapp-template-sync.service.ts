import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WhatsAppTemplateSource, WhatsAppTemplateStatus } from '../../common/enums/whatsapp.enum';
import { WhatsAppTemplate } from '../../models/whatsapp/whatsapp-template.entity';
import { MetaTemplateApiService, type MetaMessageTemplateRow } from './meta-template-api.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import {
  extractBodyPreview,
  humanizeTemplateName,
  normalizeTemplateLanguage,
  templateToResponse,
  type TemplateSyncResult,
} from './whatsapp-template.mapper';

@Injectable()
export class WhatsAppTemplateSyncService {
  private readonly logger = new Logger(WhatsAppTemplateSyncService.name);

  constructor(
    @InjectRepository(WhatsAppTemplate)
    private readonly templateRepo: Repository<WhatsAppTemplate>,
    private readonly configService: WhatsAppConfigService,
    private readonly metaTemplateApi: MetaTemplateApiService,
  ) {}

  async syncFromMeta(companyId: string): Promise<TemplateSyncResult> {
    let config = await this.configService.getActiveConfigOrThrow(companyId);
    const resolvedWaba = await this.metaTemplateApi.resolveWabaId(config);
    if (config.wabaId !== resolvedWaba) {
      config = await this.configService.updateWabaId(companyId, resolvedWaba);
    }

    this.logger.log(`Template sync started company=${companyId} waba=${resolvedWaba}`);
    const metaRows = await this.metaTemplateApi.listAllTemplates(config);
    const now = new Date();

    let created = 0;
    let updated = 0;
    const saved: WhatsAppTemplate[] = [];
    const seenKeys = new Set<string>();

    for (const meta of metaRows) {
      const language = normalizeTemplateLanguage(meta.language);
      const key = `${meta.name}:${language}`;
      seenKeys.add(key);

      const status = mapMetaStatus(meta.status);
      const qualityStatus = extractQuality(meta);

      let row = await this.templateRepo.findOne({
        where: { companyId, metaTemplateName: meta.name, language },
      });

      const payload = {
        companyId,
        name: humanizeTemplateName(meta.name),
        metaTemplateName: meta.name,
        metaTemplateId: meta.id,
        category: meta.category?.toLowerCase() ?? null,
        language,
        status,
        qualityStatus,
        components: meta.components ?? null,
        bodyPreview: extractBodyPreview(meta.components),
        isActive: true,
        lastSyncedAt: now,
        rejectionReason: null,
        source:
          row?.source === WhatsAppTemplateSource.META_LIBRARY
            ? row.source
            : WhatsAppTemplateSource.SYNCED,
        libraryTemplateName: row?.libraryTemplateName ?? null,
      };

      if (row) {
        Object.assign(row, payload);
        updated++;
      } else {
        row = this.templateRepo.create(payload);
        created++;
      }
      saved.push(await this.templateRepo.save(row));
    }

    const archived = await this.archiveMissingTemplates(companyId, seenKeys, metaRows);

    this.logger.log(
      `Template sync completed company=${companyId} synced=${saved.length} created=${created} updated=${updated} archived=${archived} pages=${metaRows.length} rows`,
    );

    return {
      synced: saved.length,
      created,
      updated,
      archived,
      templates: saved.map(r => templateToResponse(r)),
    };
  }

  private async archiveMissingTemplates(
    companyId: string,
    seenKeys: Set<string>,
    metaRows: MetaMessageTemplateRow[],
  ): Promise<number> {
    if (metaRows.length === 0) {
      return 0;
    }

    const activeLocal = await this.templateRepo.find({
      where: { companyId, isActive: true },
    });

    let archived = 0;
    for (const row of activeLocal) {
      const key = `${row.metaTemplateName}:${row.language}`;
      if (!seenKeys.has(key) && row.metaTemplateId) {
        row.isActive = false;
        row.lastSyncedAt = new Date();
        await this.templateRepo.save(row);
        archived++;
      }
    }
    return archived;
  }

}

function mapMetaStatus(metaStatus: string): WhatsAppTemplateStatus {
  switch (metaStatus?.toUpperCase()) {
    case 'APPROVED':
      return WhatsAppTemplateStatus.APPROVED;
    case 'PENDING':
    case 'IN_APPEAL':
      return WhatsAppTemplateStatus.PENDING;
    case 'REJECTED':
      return WhatsAppTemplateStatus.REJECTED;
    case 'PAUSED':
      return WhatsAppTemplateStatus.PAUSED;
    case 'DISABLED':
      return WhatsAppTemplateStatus.DISABLED;
    default:
      return WhatsAppTemplateStatus.PENDING;
  }
}

function extractQuality(meta: MetaMessageTemplateRow): string | null {
  const q = meta as MetaMessageTemplateRow & { quality_score?: { score?: string } };
  if (typeof q.quality_score === 'object' && q.quality_score?.score) {
    return String(q.quality_score.score);
  }
  return null;
}
