import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Put,
  Request,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { RequireApiKeyPermission } from '../auth/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard, FlexibleAuthGuard } from '../guards';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { UpsertPlatformInboundVoiceDto } from './dto/upsert-platform-inbound-voice.dto';
import { UpsertPlatformPhoneRouteDto } from './dto/upsert-platform-phone-route.dto';
import { PlatformInboundVoiceService } from './platform-inbound-voice.service';

/**
 * Platform-level inbound routing for Twilio /webhook/inbound when the number does not map to a company.
 *
 * **Global (default):** omit `platformCompanyId` (or set null). Flows are resolved by published
 * `flowId` only; agents/scripts by id. Call records use the resource’s own `companyId` when present.
 *
 * **Scoped:** set `platformCompanyId` to resolve the flow under that tenant `(flowId + companyId)`.
 */
@ApiTags('Platform inbound')
@Controller('platform/inbound-voice')
@UseGuards(FlexibleAuthGuard, ApiKeyPermissionGuard)
@ApiBearerAuth('BearerAuth')
@ApiSecurity('ApiKey')
export class PlatformInboundVoiceController {
  constructor(private readonly platformInboundVoice: PlatformInboundVoiceService) {}

  @Get()
  @RequireApiKeyPermission('platform', 'read')
  @ApiOperation({
    summary: 'Get platform inbound voice routing config (admin only)',
    description:
      'Returns the active row or null. Use PUT to set which agent, flow, or script handles platform inbound calls.',
  })
  get(@Request() req: { user?: { role?: string } }) {
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can view platform inbound routing');
    }
    return this.platformInboundVoice.getConfig();
  }

  @Put()
  @RequireApiKeyPermission('platform', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({ summary: 'Create or update platform inbound voice routing (admin only)' })
  put(@Body() dto: UpsertPlatformInboundVoiceDto, @Request() req: { user?: { role?: string } }) {
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can change platform inbound routing');
    }
    return this.platformInboundVoice.upsert(dto);
  }

  @Get('phone-routes')
  @RequireApiKeyPermission('platform', 'read')
  @ApiOperation({
    summary: 'List per-company Telnyx number routes (admin only)',
    description:
      'Each route maps one Telnyx DID to a company: inbound calls to that number route via its ' +
      'agent/flow/script, and outbound calls placed for that company use it as caller ID.',
  })
  listPhoneRoutes(@Request() req: { user?: { role?: string } }) {
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can view Telnyx phone routes');
    }
    return this.platformInboundVoice.listPhoneRoutes();
  }

  @Put('phone-routes')
  @RequireApiKeyPermission('platform', 'update')
  @UsePipes(ZodValidationPipe)
  @ApiOperation({
    summary: 'Create or update a per-company Telnyx number route (admin only)',
    description:
      'Adding a new company with a dedicated Telnyx number is a config-only change via this ' +
      'endpoint — no code changes or deploys required.',
  })
  putPhoneRoute(
    @Body() dto: UpsertPlatformPhoneRouteDto,
    @Request() req: { user?: { role?: string } },
  ) {
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can change Telnyx phone routes');
    }
    return this.platformInboundVoice.upsertPhoneRoute(dto);
  }

  @Delete('phone-routes/:id')
  @RequireApiKeyPermission('platform', 'update')
  @ApiOperation({ summary: 'Deactivate a per-company Telnyx number route (admin only)' })
  deletePhoneRoute(@Param('id') id: string, @Request() req: { user?: { role?: string } }) {
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('Only platform admins can change Telnyx phone routes');
    }
    return this.platformInboundVoice.deactivatePhoneRoute(id);
  }
}
