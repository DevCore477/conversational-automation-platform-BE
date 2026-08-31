import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request.types';
import { WhatsAppRoutingMode } from '../common/enums/whatsapp.enum';
import { FlexibleAuthGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { WhatsAppChatService } from './services/whatsapp-chat.service';
import { WhatsAppInboundConfigService } from './services/whatsapp-inbound-config.service';
import { WhatsAppOutboundService } from './services/whatsapp-outbound.service';
import { WhatsAppTenantService } from './services/whatsapp-tenant.service';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto';
import { PaginatedConversationsResponseDto } from './dto/paginated-conversations-response.dto';
import { UpdateConversationStatusDto } from './dto/update-conversation-status.dto';

const UpsertInboundConfigSchema = z.object({
  metaPhoneNumberId: z.string().min(1),
  companyId: z.string().optional().nullable(),
  routingMode: z.enum([
    WhatsAppRoutingMode.AGENT,
    WhatsAppRoutingMode.FLOW,
    WhatsAppRoutingMode.SCRIPT,
    WhatsAppRoutingMode.AI,
    WhatsAppRoutingMode.DATABASE_DEFAULT,
  ]),
  agentId: z.string().optional().nullable(),
  flowId: z.string().optional().nullable(),
  scriptId: z.string().optional().nullable(),
  aiModel: z.string().optional(),
  aiSystemPrompt: z.string().optional().nullable(),
  sendGreetingOnFirstMessage: z.boolean().optional(),
  markInboundAsRead: z.boolean().optional(),
});

class UpsertInboundConfigDto extends createZodDto(UpsertInboundConfigSchema) {}

@ApiTags('WhatsApp Conversations')
@UseGuards(FlexibleAuthGuard)
@ApiBearerAuth('BearerAuth')
@Controller('whatsapp')
export class WhatsAppConversationsController {
  constructor(
    private readonly chatService: WhatsAppChatService,
    private readonly inboundConfig: WhatsAppInboundConfigService,
    private readonly outboundService: WhatsAppOutboundService,
    private readonly tenantService: WhatsAppTenantService,
  ) {}

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
    @CurrentUser() user: RequestUser,
    @Query() query: ListConversationsQueryDto,
  ): Promise<PaginatedConversationsResponseDto> {
    const companyId = this.tenantService.resolveCompanyId(user);
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
  @ApiOperation({ summary: 'Chat history by phone number (company-scoped)' })
  async historyByPhone(@CurrentUser() user: RequestUser, @Param('phone') phone: string) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.chatService.listMessagesByPhone(companyId, decodeURIComponent(phone));
  }

  @Get('conversations/:contactId/history')
  @ApiOperation({ summary: 'Chat history by whatsapp_contacts id (company-scoped)' })
  async historyByContact(@CurrentUser() user: RequestUser, @Param('contactId') contactId: string) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.chatService.listMessagesByContact(companyId, contactId);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation with recent messages' })
  async getConversation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const companyId = this.tenantService.resolveCompanyId(user);
    const conversation = await this.chatService.getConversationForCompany(companyId, id);
    if (!conversation) {
      return { conversation: null, messages: [] };
    }
    const messages = await this.chatService.listMessagesForDisplay(companyId, id, 200);
    return { conversation, messages };
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'List messages (includes delivery/read status)' })
  async listMessages(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const companyId = this.tenantService.resolveCompanyId(user);
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

  @Patch('conversations/:id/status')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Update conversation status',
    description:
      'Set `open`, `closed`, or `human_handoff`. Closed conversations reopen automatically when the customer sends a new message.',
  })
  async updateConversationStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateConversationStatusDto,
  ) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.chatService.updateConversationStatus(companyId, id, dto.status);
  }

  @Post('conversations/:id/reset-routing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reset a conversation's pinned reply routing",
    description:
      'Clears any previously pinned agent/flow/script routing (and AI session) on this conversation ' +
      "so the next inbound message resolves fresh from the phone number's default inbound config. " +
      'Note: any send (message/template/campaign/bulk) without routingMode already does this ' +
      'automatically — use this endpoint when you want to unpin a conversation without sending anything.',
  })
  resetConversationRouting(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.chatService.resetReplyRoutingForCompany(companyId, id);
  }

  @Post('conversations/:id/clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear all messages in a conversation',
    description:
      'Soft-deletes the conversation and its messages in Hexa AI (hidden from inbox, retained for campaign reporting). Does not delete messages on WhatsApp servers.',
  })
  clearConversation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.chatService.clearConversation(companyId, id);
  }

  @Delete('conversations/:id/messages/:messageId')
  @ApiOperation({
    summary: 'Delete one message from conversation history',
    description:
      'Soft-deletes the message in Hexa AI (hidden from inbox, retained for campaign reporting). Cannot delete messages still pending send.',
  })
  deleteMessage(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.chatService.deleteMessage(companyId, id, messageId);
  }

  @Post('conversations/:id/messages/:messageId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a failed or pending outbound message',
    description: 'Resends using the stored body, media URL, or template name.',
  })
  retryMessage(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    const companyId = this.tenantService.resolveCompanyId(user);
    return this.outboundService.retryMessage(companyId, id, messageId);
  }

  @Put('inbound-config')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Configure inbound WhatsApp routing (agent, flow, script, or AI)',
  })
  upsertInboundConfig(@Body() dto: UpsertInboundConfigDto) {
    return this.inboundConfig.upsert(dto);
  }
}
