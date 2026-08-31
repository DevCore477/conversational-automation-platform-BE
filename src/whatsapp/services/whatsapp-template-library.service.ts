import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  WHATSAPP_TEMPLATE_CATEGORIES,
  WhatsAppTemplateSource,
  WhatsAppTemplateStatus,
} from '../../common/enums/whatsapp.enum';
import { WhatsAppTemplateLibraryCache } from '../../models/whatsapp/whatsapp-template-library-cache.entity';
import { WhatsAppTemplate } from '../../models/whatsapp/whatsapp-template.entity';
import type { CreateTemplateFromLibraryDto } from '../dto/create-template-from-library.dto';
import type { SearchTemplateLibraryQuery } from '../dto/search-template-library.dto';
import { MetaTemplateApiService } from './meta-template-api.service';
import { MetaWhatsAppGraphService } from './meta-whatsapp-graph.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import {
  buildLibraryTemplateMetaPayload,
  buildLibraryTemplatePreview,
  deriveBodyPreviewFromPayload,
  deriveComponentsFromPayload,
  resolveCustomizationMode,
} from '../utils/library-template-meta-payload.util';
import {
  humanizeTemplateName,
  normalizeTemplateLanguage,
  toMetaLanguageCode,
} from './whatsapp-template.mapper';

const LIBRARY_CACHE_TTL_MS = 15 * 60 * 1000;
const TEMPLATE_NAME_RE = /^[a-z][a-z0-9_]{0,512}$/;

export interface MetaLibraryTemplate {
  name?: string;
  language?: string;
  category?: string;
  topic?: string;
  industry?: string;
  usecase?: string;
  header?: string;
  body?: string;
  footer?: string;
  buttons?: unknown[];
  body_inputs?: unknown[];
  button_inputs?: unknown[];
  library_template_name?: string;
  [key: string]: unknown;
}

export interface TemplateLibrarySearchResult {
  templates: MetaLibraryTemplate[];
  paging: {
    before?: string;
    after?: string;
    next?: string;
    previous?: string;
  };
  meta: {
    fromCache: boolean;
    note: string;
  };
}

export interface CreateFromLibraryResult {
  metaTemplateId: string | null;
  name: string;
  language: string;
  status: string;
  localTemplateId: string;
}

@Injectable()
export class WhatsAppTemplateLibraryService {
  private readonly logger = new Logger(WhatsAppTemplateLibraryService.name);

  constructor(
    private readonly configService: WhatsAppConfigService,
    private readonly graph: MetaWhatsAppGraphService,
    private readonly metaTemplateApi: MetaTemplateApiService,
    @InjectRepository(WhatsAppTemplate)
    private readonly templateRepo: Repository<WhatsAppTemplate>,
    @InjectRepository(WhatsAppTemplateLibraryCache)
    private readonly cacheRepo: Repository<WhatsAppTemplateLibraryCache>,
  ) {}

  async searchLibrary(
    companyId: string,
    query: SearchTemplateLibraryQuery,
  ): Promise<TemplateLibrarySearchResult> {
    const config = await this.configService.getActiveConfigOrThrow(companyId);
    const searchKey = this.buildCacheKey(query);

    if (!query.skipCache) {
      const cached = await this.getValidCache(companyId, searchKey);
      if (cached) {
        return {
          templates: (cached.resultJson.templates as MetaLibraryTemplate[]) ?? [],
          paging: (cached.resultJson.paging as TemplateLibrarySearchResult['paging']) ?? {},
          meta: {
            fromCache: true,
            note: 'Meta library templates must be copied to your WABA before sending.',
          },
        };
      }
    }

    const params: Record<string, string> = {};
    if (query.search) {
      params.name_or_content = query.search;
    }
    if (query.language) {
      params.language = query.language;
    }
    if (query.category) {
      params.category = query.category.toUpperCase();
    }
    if (query.topic) {
      params.topic = query.topic.toUpperCase();
    }
    if (query.name) {
      params.name = query.name;
    }
    if (query.limit) {
      params.limit = String(query.limit);
    }
    if (query.after) {
      params.after = query.after;
    }

    this.logger.log(
      `Template library search company=${companyId} search=${query.search ?? '*'} language=${query.language ?? '*'}`,
    );

    const response = await this.graph.getJson<{
      data?: MetaLibraryTemplate[];
      paging?: TemplateLibrarySearchResult['paging'];
    }>(config, 'message_template_library', params);

    const templates = response.data ?? [];
    const paging = response.paging ?? {};

    await this.saveCache(companyId, searchKey, query, { templates, paging });

    return {
      templates,
      paging,
      meta: {
        fromCache: false,
        note: 'Meta library templates must be copied to your WABA before sending. After creation, sync or wait for approval.',
      },
    };
  }

  async createFromLibrary(
    companyId: string,
    dto: CreateTemplateFromLibraryDto,
  ): Promise<CreateFromLibraryResult> {
    const name = dto.name.trim().toLowerCase();
    if (!TEMPLATE_NAME_RE.test(name)) {
      throw new BadRequestException(
        'Template name must be lowercase snake_case (e.g. order_shipped_v1)',
      );
    }

    const category = dto.category.toUpperCase();
    if (
      !WHATSAPP_TEMPLATE_CATEGORIES.includes(
        category as (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number],
      )
    ) {
      throw new BadRequestException(
        `category must be one of: ${WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}`,
      );
    }

    const metaLanguage = toMetaLanguageCode(dto.language);
    const language = normalizeTemplateLanguage(dto.language);
    let config = await this.configService.getActiveConfigOrThrow(companyId);
    const wabaId = await this.metaTemplateApi.resolveWabaId(config);
    if (config.wabaId !== wabaId) {
      config = await this.configService.updateWabaId(companyId, wabaId);
    }

    const existing = await this.templateRepo.findOne({
      where: { companyId, metaTemplateName: name, language },
    });
    if (existing?.isActive) {
      throw new BadRequestException(
        `Template "${name}" (${language}) already exists for this company`,
      );
    }

    const libraryPreview = await this.resolveLibraryTemplatePreview(
      companyId,
      config,
      dto.libraryTemplateName,
      metaLanguage,
    );
    const createMode = resolveCustomizationMode(dto, libraryPreview);
    const metaPayload = buildLibraryTemplateMetaPayload(dto, metaLanguage, libraryPreview);

    this.logger.log(
      `Creating template from library company=${companyId} library=${dto.libraryTemplateName} name=${name} mode=${createMode}`,
    );
    this.logger.debug(`Meta from-library payload keys: ${Object.keys(metaPayload).join(', ')}`);

    const created = await this.graph.postJson<{
      id?: string;
      status?: string;
      category?: string;
    }>(config, `${wabaId}/message_templates`, metaPayload);

    const status = mapMetaStatus(created.status ?? 'PENDING');
    const components = deriveComponentsFromPayload(metaPayload);
    const bodyPreview = deriveBodyPreviewFromPayload(metaPayload, libraryPreview);
    const payload = {
      companyId,
      name: humanizeTemplateName(name),
      metaTemplateName: name,
      metaTemplateId: created.id ?? null,
      category: category.toLowerCase(),
      language,
      status,
      source: WhatsAppTemplateSource.META_LIBRARY,
      libraryTemplateName: dto.libraryTemplateName,
      isActive: true,
      lastSyncedAt: new Date(),
      components,
      bodyPreview,
      rejectionReason: null,
    };

    const row = existing
      ? await this.templateRepo.save(Object.assign(existing, payload))
      : await this.templateRepo.save(this.templateRepo.create(payload));

    return {
      metaTemplateId: row.metaTemplateId,
      name: row.metaTemplateName,
      language: row.language,
      status: row.status,
      localTemplateId: row.id,
    };
  }

  private async resolveLibraryTemplatePreview(
    companyId: string,
    config: Awaited<ReturnType<WhatsAppConfigService['getActiveConfigOrThrow']>>,
    libraryTemplateName: string,
    metaLanguage: string,
  ) {
    try {
      const response = await this.graph.getJson<{ data?: MetaLibraryTemplate[] }>(
        config,
        'message_template_library',
        { name: libraryTemplateName, language: metaLanguage, limit: '5' },
      );
      const match =
        response.data?.find(
          row =>
            row.name === libraryTemplateName || row.library_template_name === libraryTemplateName,
        ) ?? response.data?.[0];
      return buildLibraryTemplatePreview(match);
    } catch (err) {
      this.logger.debug(
        `Could not load library preview for ${libraryTemplateName}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private buildCacheKey(query: SearchTemplateLibraryQuery): string {
    return [
      query.search ?? '',
      query.language ?? '',
      query.category ?? '',
      query.topic ?? '',
      query.name ?? '',
      String(query.limit ?? 25),
      query.after ?? '',
    ].join('|');
  }

  private async getValidCache(
    companyId: string,
    searchKey: string,
  ): Promise<WhatsAppTemplateLibraryCache | null> {
    const row = await this.cacheRepo.findOne({
      where: { companyId, searchKey },
      order: { createdAt: 'DESC' },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return row;
  }

  private async saveCache(
    companyId: string,
    searchKey: string,
    query: SearchTemplateLibraryQuery,
    resultJson: Record<string, unknown>,
  ): Promise<void> {
    await this.cacheRepo.save(
      this.cacheRepo.create({
        companyId,
        searchKey,
        language: query.language ?? null,
        category: query.category ?? null,
        topic: query.topic ?? null,
        resultJson,
        expiresAt: new Date(Date.now() + LIBRARY_CACHE_TTL_MS),
      }),
    );
  }
}

function mapMetaStatus(metaStatus: string): WhatsAppTemplateStatus {
  switch (metaStatus?.toUpperCase()) {
    case 'APPROVED':
      return WhatsAppTemplateStatus.APPROVED;
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
