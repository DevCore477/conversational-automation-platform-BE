import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request.types';
import { FlexibleAuthGuard } from '../../guards';
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe';
import { CreateWhatsAppCampaignDto } from '../dto/create-campaign.dto';
import { ListCampaignRecipientsQueryDto } from '../dto/list-campaign-recipients-query.dto';
import { UpdateWhatsAppCampaignDto } from '../dto/update-campaign.dto';
import { WhatsAppCampaignService } from '../services/whatsapp-campaign.service';
import { WhatsAppTenantService } from '../services/whatsapp-tenant.service';
import { parseCampaignCsv } from '../utils/campaign-recipients.util';
import { WhatsAppMessage } from '../../models/whatsapp/whatsapp-message.entity';

@ApiTags('WhatsApp Campaigns')
@UseGuards(FlexibleAuthGuard)
@ApiBearerAuth('BearerAuth')
@Controller('whatsapp/campaigns')
export class WhatsAppCampaignsController {
  constructor(
    private readonly campaignService: WhatsAppCampaignService,
    private readonly tenantService: WhatsAppTenantService,
    @InjectRepository(WhatsAppMessage)
    private readonly messageRepo: Repository<WhatsAppMessage>,
  ) {}

  private resolveCompanyIdOptional(user: RequestUser | undefined): string | undefined {
    if (!user) {
      return undefined;
    }
    try {
      return this.tenantService.resolveCompanyId(user);
    } catch {
      return undefined;
    }
  }

  @Post()
  @ApiOperation({
    summary:
      'Create campaign from phone numbers (recipients / phones). companyId from auth — not from contacts.',
  })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateWhatsAppCampaignDto) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.campaignService.createAndEnqueue(companyId, {
      name: dto.name,
      templateId: dto.templateId,
      recipients: dto.recipients,
      phones: dto.phones,
      contactIds: dto.contactIds,
      templateParamsByPhone: dto.templateParamsByPhone,
      templateParamsByContact: dto.templateParamsByContact,
      templateVariableMapping: dto.templateVariableMapping,
      confirmRecipientsOptedIn: dto.confirmRecipientsOptedIn,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      createdByUserId: user.id,
      replyRouting: dto.routingMode
        ? {
            routingMode: dto.routingMode,
            agentId: dto.agentId,
            flowId: dto.flowId,
            scriptId: dto.scriptId,
            aiModel: dto.aiModel,
            aiSystemPrompt: dto.aiSystemPrompt,
          }
        : undefined,
    });
  }

  @Post('csv')
  @ApiOperation({
    summary: 'Create campaign from CSV (phone column required). Same opt-in rules as JSON create.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'name', 'templateId', 'confirmRecipientsOptedIn'],
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string' },
        templateId: { type: 'string', format: 'uuid' },
        confirmRecipientsOptedIn: { type: 'boolean' },
        routingMode: { type: 'string' },
        agentId: { type: 'string', format: 'uuid' },
        flowId: { type: 'string', format: 'uuid' },
        scriptId: { type: 'string', format: 'uuid' },
        aiModel: { type: 'string' },
        aiSystemPrompt: { type: 'string' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async createFromCsv(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @Body('templateId') templateId: string,
    @Body('confirmRecipientsOptedIn') confirmRecipientsOptedIn: string,
    @Body('routingMode') routingMode?: string,
    @Body('agentId') agentId?: string,
    @Body('flowId') flowId?: string,
    @Body('scriptId') scriptId?: string,
    @Body('aiModel') aiModel?: string,
    @Body('aiSystemPrompt') aiSystemPrompt?: string,
  ) {
    if (!file.buffer.length) {
      throw new BadRequestException('CSV file is required');
    }
    if (!name.trim() || !templateId.trim()) {
      throw new BadRequestException('name and templateId are required');
    }
    const companyId = this.tenantService.resolveCompanyId(user);
    const recipients = parseCampaignCsv(file.buffer);

    return this.campaignService.createAndEnqueue(companyId, {
      name,
      templateId,
      recipients,
      confirmRecipientsOptedIn: confirmRecipientsOptedIn === 'true',
      createdByUserId: user.id,
      replyRouting: routingMode
        ? {
            routingMode: routingMode as CreateWhatsAppCampaignDto['routingMode'],
            agentId: agentId ?? null,
            flowId: flowId ?? null,
            scriptId: scriptId ?? null,
            aiModel,
            aiSystemPrompt: aiSystemPrompt ?? null,
          }
        : undefined,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List campaigns for authenticated user company' })
  list(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.campaignService.listForCompany(
      companyId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  @Get('all-stats')
  @ApiOperation({ summary: 'Aggregate sending stats for company' })
  async allStats(@CurrentUser() user: RequestUser) {
    const companyId = this.resolveCompanyIdOptional(user);
    return this.campaignService.getAllStats(companyId);
  }

  @Get('all-messages-stats')
  @ApiOperation({ summary: 'Message status counts for company' })
  async allMessagesStats(@CurrentUser() user: RequestUser) {
    const companyId = this.resolveCompanyIdOptional(user);
    if (!companyId) {
      return {
        companyId: null,
        campaignCount: 0,
        messagesByStatus: {},
      };
    }

    const campaignCount = await this.campaignService.getAllCampaigns(companyId);
    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin('whatsapp_campaigns', 'c', 'c.id = m.campaignId')
      .select('m.status', 'status')
      .addSelect('COUNT(m.id)', 'count')
      .where('m.companyId = :companyId', { companyId })
      .andWhere('c.companyId = :companyId', { companyId })
      .groupBy('m.status')
      .getRawMany<{
        status: string;
        count: string;
      }>();

    return {
      companyId,
      campaignCount,
      messagesByStatus: messages.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = Number(row.count);
        return acc;
      }, {}),
    };
  }

  @Get(':id/stats')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Campaign delivery stats' })
  stats(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListCampaignRecipientsQueryDto,
  ) {
    const companyId = this.tenantService.resolveCampaignCompanyScope(user, query.companyId);
    return this.campaignService.getStats(id, companyId);
  }

  @Patch(':id')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update campaign metadata (e.g. name)' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWhatsAppCampaignDto,
    @Query() query: ListCampaignRecipientsQueryDto,
  ) {
    const companyId = this.tenantService.resolveCampaignCompanyScope(user, query.companyId);
    return this.campaignService.update(id, { name: dto.name }, companyId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Delete a campaign (not allowed while sending)' })
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListCampaignRecipientsQueryDto,
  ) {
    const companyId = this.tenantService.resolveCampaignCompanyScope(user, query.companyId);
    return this.campaignService.delete(id, companyId);
  }

  @Get(':id')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Get campaign details',
    description:
      'Returns campaign stats, linked template, message preview, and paginated recipient delivery rows. ' +
      'Super Admin may omit company scope or pass `companyId` query param.',
  })
  getCampaign(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListCampaignRecipientsQueryDto,
  ) {
    const companyId = this.tenantService.resolveCampaignCompanyScope(user, query.companyId);
    return this.campaignService.getDetails(
      id,
      {
        page: query.page,
        limit: query.limit,
      },
      companyId,
    );
  }
}
