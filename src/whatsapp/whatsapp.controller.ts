import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request.types';
import { FlexibleAuthGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { WhatsAppTenantService } from './services/whatsapp-tenant.service';
import { BulkSendTextWhatsAppDto, BulkSendWhatsAppDto } from './dto/bulk-send-whatsapp.dto';
import { WhatsAppReplyRoutingSchema } from './types/whatsapp-reply-routing.types';
import {
  PreviewWhatsAppDesignDto,
  SendDesignedWhatsAppDto,
} from './dto/design-whatsapp-message.dto';
import { SendWhatsAppMessageDto } from './dto/send-whatsapp-message.dto';
import { SendWhatsAppTemplateDto } from './dto/send-whatsapp-template.dto';
import { SAMPLE_CSV } from './utils/csv-recipients.util';
import { WhatsAppBulkService } from './whatsapp-bulk.service';
import { WhatsAppMessageBuilderService } from './whatsapp-message-builder.service';
import { WhatsAppService } from './whatsapp.service';

@ApiTags('WhatsApp')
@UseGuards(FlexibleAuthGuard)
@ApiBearerAuth('BearerAuth')
@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly messageBuilder: WhatsAppMessageBuilderService,
    private readonly bulkService: WhatsAppBulkService,
    private readonly tenantService: WhatsAppTenantService,
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

  @Get('health')
  @ApiOperation({ summary: 'Check WhatsApp provider connectivity' })
  health() {
    return this.whatsAppService.healthCheck();
  }

  @Get('config')
  @ApiOperation({ summary: 'WhatsApp module configuration status' })
  config() {
    return {
      configured: this.whatsAppService.isConfigured(),
      provider: this.whatsAppService.getProvider(),
    };
  }

  // ─── Message designer ─────────────────────────────────────────────────────

  @Get('messages/design/schema')
  @ApiOperation({
    summary: 'Message design types reference',
    description:
      'Supported design types: text, template, media, interactive_buttons, interactive_list. Use {{variable}} in text for per-recipient substitution.',
  })
  designSchema() {
    return {
      types: [
        {
          type: 'text',
          example: { type: 'text', body: 'Hello {{name}}, your order {{orderId}} is ready!' },
        },
        {
          type: 'template',
          example: {
            type: 'template',
            templateName: 'hello_world',
            parameters: ['Ali'],
            languageCode: 'en',
          },
        },
        {
          type: 'media',
          example: {
            type: 'media',
            mediaType: 'image',
            url: 'https://example.com/promo.jpg',
            caption: 'Summer sale',
          },
        },
        {
          type: 'interactive_buttons',
          example: {
            type: 'interactive_buttons',
            body: 'Confirm your appointment?',
            buttons: [
              { id: 'yes', title: 'Yes' },
              { id: 'no', title: 'No' },
            ],
          },
        },
        {
          type: 'interactive_list',
          example: {
            type: 'interactive_list',
            body: 'Choose a department',
            buttonText: 'Select',
            sections: [
              {
                title: 'Support',
                rows: [
                  { id: 'sales', title: 'Sales' },
                  { id: 'billing', title: 'Billing' },
                ],
              },
            ],
          },
        },
      ],
    };
  }

  @Post('messages/design/preview')
  @HttpCode(HttpStatus.OK)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Preview a runtime-designed WhatsApp message',
    description: 'Build and inspect the Meta API payload without sending.',
  })
  @ApiBody({ type: PreviewWhatsAppDesignDto })
  previewDesign(@Body() dto: PreviewWhatsAppDesignDto) {
    return this.messageBuilder.preview(dto.design, dto.variables, dto.examplePhone);
  }

  @Post('messages/design/send')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Send a runtime-designed WhatsApp message to one recipient' })
  @ApiBody({ type: SendDesignedWhatsAppDto })
  sendDesigned(@CurrentUser() user: RequestUser, @Body() dto: SendDesignedWhatsAppDto) {
    return this.whatsAppService.sendDesigned(
      dto.design,
      dto.to,
      dto.variables,
      this.resolveCompanyIdOptional(user),
      dto.routingMode
        ? {
            routingMode: dto.routingMode,
            agentId: dto.agentId,
            flowId: dto.flowId,
            scriptId: dto.scriptId,
            aiModel: dto.aiModel,
            aiSystemPrompt: dto.aiSystemPrompt,
          }
        : undefined,
    );
  }

  // ─── Single send ─────────────────────────────────────────────────

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Send a WhatsApp text or media message',
    description:
      "Free-form text/media only delivers within 24h of the customer's last inbound message. " +
      'Outside that window, set templateName (or WHATSAPP_DEFAULT_OUTBOUND_TEMPLATE_NAME) to send an approved template with the body as {{1}}.',
  })
  @ApiBody({ type: SendWhatsAppMessageDto })
  sendMessage(@CurrentUser() user: RequestUser, @Body() dto: SendWhatsAppMessageDto) {
    return this.whatsAppService.sendMessage(dto, this.resolveCompanyIdOptional(user));
  }

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Send a single WhatsApp template message',
    description:
      'Use templateId (from GET /whatsapp/message-templates) or templateName. ' +
      'Pass body variables via parameters, contentVariables, bodyParameters, or components ' +
      '(header/body/button). Works outside the 24h session window.',
  })
  @ApiBody({ type: SendWhatsAppTemplateDto })
  sendTemplate(@CurrentUser() user: RequestUser, @Body() dto: SendWhatsAppTemplateDto) {
    return this.whatsAppService.sendTemplate(dto, this.resolveCompanyIdOptional(user));
  }

  @Post('messages/template')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Send a single WhatsApp template message (alias)',
    description: 'Same as POST /whatsapp/templates.',
  })
  @ApiBody({ type: SendWhatsAppTemplateDto })
  sendTemplateMessage(@CurrentUser() user: RequestUser, @Body() dto: SendWhatsAppTemplateDto) {
    return this.whatsAppService.sendTemplate(dto, this.resolveCompanyIdOptional(user));
  }

  @Get('messages/:messageSid/status')
  @ApiParam({ name: 'messageSid', description: 'Meta message id (wamid)' })
  getStatus(@Param('messageSid') messageSid: string) {
    return this.whatsAppService.getMessageStatus(messageSid);
  }

  // ─── Bulk send ────────────────────────────────────────────────────────────

  @Get('bulk/csv/sample')
  @Header('Content-Type', 'text/csv')
  @ApiOperation({
    summary: 'Download sample CSV for bulk campaigns',
    description:
      'Columns: phone (required), message (optional), plus any variable columns used in {{placeholders}} (e.g. name, from, date, credit).',
  })
  sampleCsv(): string {
    return SAMPLE_CSV;
  }

  @Post('bulk')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Bulk send with a message design + recipient list (JSON)',
    description:
      'Use `dryRun: true` to validate and preview without sending. `delayMs` spaces requests for Meta rate limits.',
  })
  @ApiBody({ type: BulkSendWhatsAppDto })
  bulkSend(@CurrentUser() user: RequestUser, @Body() dto: BulkSendWhatsAppDto) {
    return this.bulkService.sendBulk({
      design: dto.design,
      recipients: dto.recipients,
      options: {
        delayMs: dto.delayMs,
        dryRun: dto.dryRun,
        stopOnError: dto.stopOnError,
        routingMode: dto.routingMode,
        agentId: dto.agentId,
        flowId: dto.flowId,
        scriptId: dto.scriptId,
        aiModel: dto.aiModel,
        aiSystemPrompt: dto.aiSystemPrompt,
      },
      companyId: this.resolveCompanyIdOptional(user),
    });
  }

  @Post('bulk/text')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Bulk send plain text (same message pattern, per-row overrides)',
    description:
      'Message supports {{name}} placeholders; each recipient can pass variables or a full message override.',
  })
  @ApiBody({ type: BulkSendTextWhatsAppDto })
  bulkSendText(@CurrentUser() user: RequestUser, @Body() dto: BulkSendTextWhatsAppDto) {
    return this.bulkService.sendBulkText({
      defaultMessage: dto.message,
      recipients: dto.recipients,
      options: {
        delayMs: dto.delayMs,
        dryRun: dto.dryRun,
        stopOnError: dto.stopOnError,
        routingMode: dto.routingMode,
        agentId: dto.agentId,
        flowId: dto.flowId,
        scriptId: dto.scriptId,
        aiModel: dto.aiModel,
        aiSystemPrompt: dto.aiSystemPrompt,
      },
      companyId: this.resolveCompanyIdOptional(user),
    });
  }

  @Post('bulk/csv')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Bulk send from CSV upload',
    description:
      'Upload CSV with phone (required), optional message column, and any extra columns matching {{variables}} in your design or message (e.g. from, date, credit). ' +
      'Pass optional `design` JSON in the form (e.g. {"type":"text","body":"Hi {{name}}, balance {{credit}} on {{date}}"}), or use a message column with placeholders per row. ' +
      'Optional reply routing fields (`routingMode`, `agentId`, `flowId`, `scriptId`, `aiModel`, `aiSystemPrompt`) pin which agent/flow/script handles inbound replies.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV file' },
        design: {
          type: 'string',
          description: 'JSON message design (optional if CSV has message column)',
        },
        delayMs: { type: 'number', example: 800 },
        dryRun: { type: 'boolean', example: false },
        stopOnError: { type: 'boolean', example: false },
        routingMode: {
          type: 'string',
          enum: ['agent', 'flow', 'script', 'ai', 'database_default'],
        },
        agentId: { type: 'string', format: 'uuid' },
        flowId: { type: 'string', format: 'uuid' },
        scriptId: { type: 'string', format: 'uuid' },
        aiModel: { type: 'string', example: 'gpt-4o-mini' },
        aiSystemPrompt: { type: 'string' },
      },
    },
  })
  @ApiQuery({ name: 'delayMs', required: false, type: Number })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  bulkSendCsv(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('design') designJson?: string,
    @Query('delayMs') delayMs?: string,
    @Query('dryRun') dryRun?: string,
    @Query('stopOnError') stopOnError?: string,
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

    let design: unknown;
    if (designJson?.trim()) {
      try {
        design = JSON.parse(designJson) as unknown;
      } catch {
        throw new BadRequestException('Invalid design JSON in form field');
      }
    }

    let replyRouting = {};
    if (routingMode) {
      const parsed = WhatsAppReplyRoutingSchema.safeParse({
        routingMode,
        agentId: agentId ?? null,
        flowId: flowId ?? null,
        scriptId: scriptId ?? null,
        aiModel,
        aiSystemPrompt: aiSystemPrompt ?? null,
      });
      if (!parsed.success) {
        throw new BadRequestException(parsed.error.flatten());
      }
      replyRouting = parsed.data;
    }

    return this.bulkService.sendBulkFromCsv({
      file: file.buffer,
      design,
      options: {
        delayMs: delayMs ? Number(delayMs) : undefined,
        dryRun: dryRun === 'true',
        stopOnError: stopOnError === 'true',
        ...replyRouting,
      },
      companyId: this.resolveCompanyIdOptional(user),
    });
  }
}
