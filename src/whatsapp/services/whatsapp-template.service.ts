import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  WHATSAPP_TEMPLATE_USABLE_STATUSES,
  WhatsAppTemplateSource,
  WhatsAppTemplateStatus,
} from '../../common/enums/whatsapp.enum';
import { WhatsAppTemplate } from '../../models/whatsapp/whatsapp-template.entity';
import type { CreateWhatsAppTemplateDto } from '../dto/create-whatsapp-template.dto';
import type { UpdateWhatsAppTemplateDto } from '../dto/update-whatsapp-template.dto';
import { MetaTemplateApiService } from './meta-template-api.service';
import { WhatsAppConfigService } from './whatsapp-config.service';
import { WhatsAppTemplateSyncService } from './whatsapp-template-sync.service';
import {
  extractBodyPreview,
  humanizeTemplateName,
  normalizeTemplateLanguage,
  templateToResponse,
  type TemplateSyncResult,
  type WhatsAppTemplateResponse,
} from './whatsapp-template.mapper';

export type { TemplateSyncResult, WhatsAppTemplateResponse } from './whatsapp-template.mapper';
export {
  extractBodyPreview,
  humanizeTemplateName,
  normalizeTemplateLanguage,
  templateToResponse,
} from './whatsapp-template.mapper';

@Injectable()
export class WhatsAppTemplateService {
  constructor(
    @InjectRepository(WhatsAppTemplate)
    private readonly templateRepo: Repository<WhatsAppTemplate>,
    private readonly configService: WhatsAppConfigService,
    private readonly metaTemplateApi: MetaTemplateApiService,
    private readonly syncService: WhatsAppTemplateSyncService,
  ) {}

  toResponse(row: WhatsAppTemplate): WhatsAppTemplateResponse {
    return templateToResponse(row);
  }

  async listForCompany(
    companyId: string,
    opts?: {
      status?: string;
      approvedOnly?: boolean;
      activeOnly?: boolean;
      page?: number;
      limit?: number;
    },
  ): Promise<WhatsAppTemplateResponse[] | { data: WhatsAppTemplateResponse[]; meta: object }> {
    const page = Math.max(1, opts?.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 100));
    const skip = (page - 1) * limit;

    const qb = this.templateRepo
      .createQueryBuilder('t')
      .where('t.companyId = :companyId', { companyId })
      .orderBy('t.name', 'ASC');

    if (opts?.activeOnly !== false) {
      qb.andWhere('t.isActive = :active', { active: true });
    }
    if (opts?.status) {
      qb.andWhere('t.status = :status', { status: opts.status });
    } else if (opts?.approvedOnly) {
      qb.andWhere('t.status = :approved', { approved: WhatsAppTemplateStatus.APPROVED });
    }

    if (opts?.page != null || (opts?.limit != null && opts.limit < 100)) {
      const [rows, total] = await qb.skip(skip).take(limit).getManyAndCount();
      const totalPages = Math.max(1, Math.ceil(total / limit));
      return {
        data: rows.map(r => this.toResponse(r)),
        meta: {
          currentPage: page,
          itemsPerPage: limit,
          totalItems: total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      };
    }

    const rows = await qb.getMany();
    return rows.map(r => this.toResponse(r));
  }

  async getById(companyId: string, templateId: string): Promise<WhatsAppTemplateResponse> {
    const row = await this.templateRepo.findOne({ where: { id: templateId, companyId } });
    if (!row) {
      throw new NotFoundException('Template not found');
    }
    return this.toResponse(row);
  }

  async findByMetaName(
    companyId: string,
    metaTemplateName: string,
    language?: string,
  ): Promise<WhatsAppTemplate | null> {
    const where: { companyId: string; metaTemplateName: string; language?: string } = {
      companyId,
      metaTemplateName,
    };
    if (language) {
      where.language = normalizeTemplateLanguage(language);
    }
    return this.templateRepo.findOne({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  async getApprovedEntity(companyId: string, templateId: string): Promise<WhatsAppTemplate> {
    const row = await this.templateRepo.findOne({ where: { id: templateId, companyId } });
    if (!row) {
      throw new NotFoundException('Template not found');
    }
    if (!row.isActive) {
      throw new BadRequestException(
        `Template "${row.name}" is archived. Sync from Meta or create a new template.`,
      );
    }
    if (!WHATSAPP_TEMPLATE_USABLE_STATUSES.has(row.status)) {
      throw new BadRequestException(
        `Template "${row.name}" is not approved for sending (status: ${row.status}). ` +
          'Use an approved template or sync from Meta.',
      );
    }
    return row;
  }

  /** @deprecated use getApprovedEntity */
  async getApprovedForCompany(companyId: string, templateId: string): Promise<WhatsAppTemplate> {
    return this.getApprovedEntity(companyId, templateId);
  }

  async create(
    companyId: string,
    dto: CreateWhatsAppTemplateDto,
  ): Promise<WhatsAppTemplateResponse> {
    const existing = await this.templateRepo.findOne({
      where: {
        companyId,
        metaTemplateName: dto.metaTemplateName,
        language: dto.language ?? 'en',
      },
    });
    if (existing) {
      throw new ConflictException(
        `Template ${dto.metaTemplateName} (${dto.language}) already exists for this company`,
      );
    }

    const row = await this.templateRepo.save(
      this.templateRepo.create({
        companyId,
        name: dto.name,
        metaTemplateName: dto.metaTemplateName,
        language: dto.language ?? 'en',
        category: dto.category ?? null,
        status: dto.status ?? WhatsAppTemplateStatus.APPROVED,
        source: WhatsAppTemplateSource.CUSTOM,
        isActive: true,
        components: dto.components ?? null,
        bodyPreview: dto.bodyPreview ?? extractBodyPreview(dto.components),
      }),
    );

    return this.toResponse(row);
  }

  async update(
    companyId: string,
    templateId: string,
    dto: UpdateWhatsAppTemplateDto,
  ): Promise<WhatsAppTemplateResponse> {
    const row = await this.templateRepo.findOne({ where: { id: templateId, companyId } });
    if (!row) {
      throw new NotFoundException('Template not found');
    }

    if (dto.name != null) {
      row.name = dto.name;
    }
    if (dto.category !== undefined) {
      row.category = dto.category;
    }
    if (dto.status != null) {
      row.status = dto.status;
    }
    if (dto.components !== undefined) {
      row.components = dto.components;
      if (dto.bodyPreview === undefined) {
        row.bodyPreview = extractBodyPreview(dto.components);
      }
    }
    if (dto.bodyPreview !== undefined) {
      row.bodyPreview = dto.bodyPreview;
    }

    return this.toResponse(await this.templateRepo.save(row));
  }

  async remove(companyId: string, templateId: string): Promise<{ deleted: true }> {
    const result = await this.templateRepo.delete({ id: templateId, companyId });
    if (!result.affected) {
      throw new NotFoundException('Template not found');
    }
    return { deleted: true };
  }

  async syncFromMeta(companyId: string): Promise<TemplateSyncResult> {
    return this.syncService.syncFromMeta(companyId);
  }

  async applyWebhookStatusUpdate(params: {
    companyId: string;
    metaTemplateName: string;
    language: string;
    status: string;
    metaTemplateId?: string;
    rejectionReason?: string;
    category?: string;
    qualityStatus?: string;
  }): Promise<void> {
    const language = normalizeTemplateLanguage(params.language);
    const status = mapMetaStatus(params.status);

    let row = await this.templateRepo.findOne({
      where: { companyId: params.companyId, metaTemplateName: params.metaTemplateName, language },
    });

    if (!row) {
      row = this.templateRepo.create({
        companyId: params.companyId,
        name: humanizeTemplateName(params.metaTemplateName),
        metaTemplateName: params.metaTemplateName,
        language,
        status,
        source: WhatsAppTemplateSource.SYNCED,
        isActive: true,
      });
    }

    row.status = status;
    if (params.metaTemplateId) {
      row.metaTemplateId = params.metaTemplateId;
    }
    if (params.rejectionReason) {
      row.rejectionReason = params.rejectionReason;
    }
    if (params.category) {
      row.category = params.category.toLowerCase();
    }
    if (params.qualityStatus) {
      row.qualityStatus = params.qualityStatus;
    }
    row.lastSyncedAt = new Date();

    await this.templateRepo.save(row);
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

