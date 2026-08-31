import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request.types';
import { FlexibleAuthGuard } from '../../guards';
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe';
import { CreateTemplateFromLibraryDto } from '../dto/create-template-from-library.dto';
import { CreateWhatsAppTemplateDto } from '../dto/create-whatsapp-template.dto';
import { ListCompanyTemplatesQueryDto } from '../dto/list-company-templates-query.dto';
import { SearchTemplateLibraryQueryDto } from '../dto/search-template-library.dto';
import { UpdateWhatsAppTemplateDto } from '../dto/update-whatsapp-template.dto';
import { WhatsAppTemplateLibraryService } from '../services/whatsapp-template-library.service';
import { WhatsAppTemplateService } from '../services/whatsapp-template.service';
import { WhatsAppTenantService } from '../services/whatsapp-tenant.service';

@ApiTags('WhatsApp Templates')
@UseGuards(FlexibleAuthGuard)
@ApiBearerAuth('BearerAuth')
@Controller('whatsapp/message-templates')
export class WhatsAppTemplatesController {
  constructor(
    private readonly templateService: WhatsAppTemplateService,
    private readonly libraryService: WhatsAppTemplateLibraryService,
    private readonly tenantService: WhatsAppTenantService,
  ) {}

  @Get('library')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Browse Meta WhatsApp template library',
    description:
      'Returns Meta library templates for discovery. Copy to your WABA via POST .../from-library before sending.',
  })
  searchLibrary(@CurrentUser() user: RequestUser, @Query() query: SearchTemplateLibraryQueryDto) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.libraryService.searchLibrary(companyId, query);
  }

  @Post('from-library')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Create a company WABA template from a Meta library template',
    description:
      'Customize header, body, footer, variable samples, and buttons like Meta WAM. ' +
      'Use customization.header/body/footer or pass customization.components for full control.',
  })
  createFromLibrary(@CurrentUser() user: RequestUser, @Body() dto: CreateTemplateFromLibraryDto) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.libraryService.createFromLibrary(companyId, dto);
  }

  @Get()
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'List templates registered for your company',
    description:
      'Templates must exist in Meta and be synced or registered here before use in campaigns.',
  })
  @ApiQuery({ name: 'approvedOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'status', required: false, type: String })
  list(@CurrentUser() user: RequestUser, @Query() query: ListCompanyTemplatesQueryDto) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.templateService.listForCompany(companyId, {
      approvedOnly: query.approvedOnly,
      status: query.status,
      activeOnly: !query.includeInactive,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post('sync')
  @ApiOperation({
    summary: 'Sync all templates from Meta into the database',
    description:
      'Requires company WhatsApp config (wabaId or phoneNumberId). Upserts by metaTemplateName + language.',
  })
  sync(@CurrentUser() user: RequestUser) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.templateService.syncFromMeta(companyId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one template by id' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.templateService.getById(companyId, id);
  }

  @Post()
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Register a Meta-approved template in Hexa AI',
    description:
      'Create the template in Meta Business Manager first, wait for approval, then register ' +
      'the exact metaTemplateName and language here (or use POST /whatsapp/message-templates/sync).',
  })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateWhatsAppTemplateDto) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.templateService.create(companyId, dto);
  }

  @Patch(':id')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Update display name, status, or preview (not metaTemplateName)' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateWhatsAppTemplateDto,
  ) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.templateService.update(companyId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove template from Hexa AI (does not delete from Meta)' })
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.templateService.remove(companyId, id);
  }
}
