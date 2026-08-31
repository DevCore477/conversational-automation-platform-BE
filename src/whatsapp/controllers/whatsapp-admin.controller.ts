import {
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
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserRole } from '../../common/enums';
import { JwtAuthGuard, RolesGuard } from '../../guards';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CreateCompanyWhatsAppConfigDto } from '../dto/create-company-whatsapp-config.dto';
import { WhatsAppCampaignService } from '../services/whatsapp-campaign.service';
import { WhatsAppConfigService } from '../services/whatsapp-config.service';
import { WhatsAppTemplateLibraryService } from '../services/whatsapp-template-library.service';
import { WhatsAppTemplateService } from '../services/whatsapp-template.service';
import { SearchTemplateLibraryQueryDto } from '../dto/search-template-library.dto';
import { CreateTemplateFromLibraryDto } from '../dto/create-template-from-library.dto';
import { ListCompanyTemplatesQueryDto } from '../dto/list-company-templates-query.dto';
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe';
import { CreateWhatsAppTemplateDto } from '../dto/create-whatsapp-template.dto';
import { WhatsAppCampaign } from '../../models/whatsapp/whatsapp-campaign.entity';
import { WhatsAppMessage } from '../../models/whatsapp/whatsapp-message.entity';
import { PaginatedConversationsResponseDto } from '../dto/paginated-conversations-response.dto';
import { ListConversationsQueryDto } from '../dto/list-conversations-query.dto';
import { ListCampaignRecipientsQueryDto } from '../dto/list-campaign-recipients-query.dto';
import { UpdateWhatsAppCampaignDto } from '../dto/update-campaign.dto';
import { WhatsAppChatService } from '../services/whatsapp-chat.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request.types';

@ApiTags('WhatsApp Super Admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth('BearerAuth')
@Controller('admin/companies/:companyId/whatsapp')
export class WhatsAppAdminController {
  constructor(
    private readonly configService: WhatsAppConfigService,
    private readonly campaignService: WhatsAppCampaignService,
    private readonly templateService: WhatsAppTemplateService,
    private readonly libraryService: WhatsAppTemplateLibraryService,
    @InjectRepository(WhatsAppCampaign)
    private readonly campaignRepo: Repository<WhatsAppCampaign>,
    @InjectRepository(WhatsAppMessage)
    private readonly messageRepo: Repository<WhatsAppMessage>,
    private readonly chatService: WhatsAppChatService,
  ) {}

  @Post('config')
  @ApiOperation({ summary: 'Create or update company WhatsApp Meta configuration' })
  upsertConfig(@Param('companyId') companyId: string, @Body() dto: CreateCompanyWhatsAppConfigDto) {
    return this.configService.upsertForCompany(companyId, dto);
  }

  @Get('config')
  @ApiOperation({ summary: 'Get company WhatsApp config (tokens masked)' })
  getConfig(@Param('companyId') companyId: string) {
    return this.configService.getForCompany(companyId);
  }

  @Patch('config/status')
  @ApiOperation({ summary: 'Activate or deactivate company WhatsApp config' })
  setStatus(@Param('companyId') companyId: string, @Body('isActive') isActive: boolean) {
    return this.configService.setActive(companyId, isActive);
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'List company campaigns' })
  campaigns(
    @Param('companyId') companyId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.campaignService.listForCompany(
      companyId,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
  }

  @Get('campaigns/:campaignId')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Get campaign details for company',
    description:
      'Campaign stats, template, message preview, and paginated recipients (Super Admin).',
  })
  campaignDetails(
    @Param('companyId') companyId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Query() query: ListCampaignRecipientsQueryDto,
  ) {
    return this.campaignService.getDetails(
      campaignId,
      {
        page: query.page,
        limit: query.limit,
      },
      companyId,
    );
  }

  @Patch('campaigns/:campaignId')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update campaign metadata for company (Super Admin)' })
  updateCampaign(
    @Param('companyId') companyId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: UpdateWhatsAppCampaignDto,
  ) {
    return this.campaignService.update(campaignId, { name: dto.name }, companyId);
  }

  @Delete('campaigns/:campaignId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete company campaign (Super Admin)' })
  deleteCampaign(
    @Param('companyId') companyId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ) {
    return this.campaignService.delete(campaignId, companyId);
  }

  @Get('message-templates/library')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Browse Meta template library for company WABA' })
  searchTemplateLibrary(
    @Param('companyId') companyId: string,
    @Query() query: SearchTemplateLibraryQueryDto,
  ) {
    return this.libraryService.searchLibrary(companyId, query);
  }

  @Post('message-templates/from-library')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Create WABA template from Meta library (Super Admin)' })
  createFromLibrary(
    @Param('companyId') companyId: string,
    @Body() dto: CreateTemplateFromLibraryDto,
  ) {
    return this.libraryService.createFromLibrary(companyId, dto);
  }

  @Get('message-templates')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'List company message templates' })
  listTemplates(
    @Param('companyId') companyId: string,
    @Query() query: ListCompanyTemplatesQueryDto,
  ) {
    return this.templateService.listForCompany(companyId, {
      approvedOnly: query.approvedOnly,
      status: query.status,
      activeOnly: !query.includeInactive,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('message-templates/:id')
  @ApiOperation({ summary: 'Get one template by id' })
  get(@Param('companyId') companyId: string, @Param('id') id: string) {
    return this.templateService.getById(companyId, id);
  }

  @Get('conversations')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'List WhatsApp conversations (paginated, filterable)',
    description:
      'Filters: `status`, `unreadOnly`, `search` (phone substring), `contactId`. ' +
      'Sort: `lastMessageAt` (default), `createdAt`, `unreadCount`. Pagination: `page`, `limit` (max 100).',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'open' })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Phone number search' })
  @ApiQuery({ name: 'contactId', required: false, type: String })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['lastMessageAt', 'createdAt', 'unreadCount'],
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['ASC', 'DESC'] })
  @ApiResponse({ status: 200, type: PaginatedConversationsResponseDto })
  listConversations(
    @Param('companyId') companyId: string,
    @Query() query: ListConversationsQueryDto,
  ): Promise<PaginatedConversationsResponseDto> {
    return this.chatService.listConversationsPaginated({
      companyId,
      page: query.page,
      limit: query.limit,
      status: query.status,
      unreadOnly: query.unreadOnly,
      search: query.search,
      contactId: query.contactId,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('conversations/by-phone/:phone/history')
  @ApiOperation({ summary: 'Chat history by phone number (Super Admin)' })
  historyByPhone(@Param('companyId') companyId: string, @Param('phone') phone: string) {
    return this.chatService.listMessagesByPhone(companyId, decodeURIComponent(phone));
  }

  @Get('conversations/:contactId/history')
  @ApiOperation({ summary: 'Chat history by whatsapp_contacts id (Super Admin)' })
  historyByContact(
    @Param('companyId') companyId: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    return this.chatService.listMessagesByContact(companyId, contactId);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation with recent messages (Super Admin)' })
  async getConversation(
    @Param('companyId') companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const conversation = await this.chatService.getConversationForCompany(companyId, id);
    if (!conversation) {
      return { conversation: null, messages: [] };
    }
    const messages = await this.chatService.listMessagesForDisplay(companyId, id, 200);
    return { conversation, messages };
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'List conversation messages (Super Admin)' })
  async listMessages(
    @Param('companyId') companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const conversation = await this.chatService.getConversationForCompany(companyId, id);
    if (!conversation) {
      return [];
    }
    return this.chatService.listMessagesForDisplay(
      companyId,
      id,
      limit ? Number(limit) : 100,
      offset ? Number(offset) : 0,
    );
  }

  @Post('message-templates/sync')
  @ApiOperation({ summary: 'Sync templates from Meta for company' })
  syncTemplates(@Param('companyId') companyId: string) {
    return this.templateService.syncFromMeta(companyId);
  }

  @Post('message-templates')
  @ApiOperation({ summary: 'Register template for company (Super Admin)' })
  createTemplate(@Param('companyId') companyId: string, @Body() dto: CreateWhatsAppTemplateDto) {
    return this.templateService.create(companyId, dto);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Aggregate sending stats for company' })
  async stats(@Param('companyId', ParseUUIDPipe) companyId: string) {
    const campaigns = await this.campaignRepo.count({ where: { companyId } });
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
      campaignCount: campaigns,
      messagesByStatus: messages.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = Number(row.count);
        return acc;
      }, {}),
    };
  }
}
