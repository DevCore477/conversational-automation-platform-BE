import { Controller, Get, Logger, Post, Query, Request, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { LinkedInCallbackQueryDto } from './dto/linkedin-callback-query.dto';
import { LinkedInService } from './linkedin.service';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../common/types/request.types';
import { UserRole } from '../common/enums';
import { FlexibleAuthGuard, RolesGuard } from '../guards';

/**
 * Hexa AI has exactly one LinkedIn Company Page connection (the website's own blog feed),
 * so these endpoints are internal-admin only — not scoped to a customer/tenant company.
 * The organization id is never entered by hand: it's discovered from the connecting
 * member's own admin access during the OAuth callback (see LinkedInService.discoverOrganization).
 */
@ApiTags('LinkedIn')
@Controller('linkedin')
export class LinkedInController {
  private readonly logger = new Logger(LinkedInController.name);

  constructor(
    private readonly linkedInService: LinkedInService,
    private readonly configService: ConfigService,
  ) {}

  @Post('connect')
  @UseGuards(FlexibleAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Start LinkedIn OAuth — returns the authorization URL to redirect to' })
  connect(@Request() req: AuthenticatedRequest) {
    const url = this.linkedInService.buildConnectUrl(req.user.id);
    return { url };
  }

  /**
   * LinkedIn redirects the admin's browser here after consent — no auth header present,
   * identity comes from the signed `state` param minted in connect().
   */
  @Get('callback')
  @ApiOperation({ summary: 'OAuth callback — exchanges the code and redirects back to the app' })
  async callback(@Query() query: LinkedInCallbackQueryDto, @Res() res: Response) {
    this.logger.log(
      `GET /linkedin/callback query: code=${query.code ? `${query.code.slice(0, 6)}…(len ${String(query.code.length)})` : '(none)'} ` +
        `state=${query.state ? 'present' : '(none)'} error=${query.error ?? '(none)'} ` +
        `error_description=${query.error_description ?? '(none)'}`,
    );

    const frontendBaseUrl = this.configService.get<string>('linkedin.frontendBaseUrl') ?? '';
    const redirectTo = (status: 'connected' | 'error', message?: string) => {
      const url = new URL('/settings/integrations/linkedin', frontendBaseUrl || 'http://localhost');
      url.searchParams.set('status', status);
      if (message) url.searchParams.set('message', message);
      if (frontendBaseUrl) {
        res.redirect(url.toString());
      } else {
        res.status(200).json({ status, message });
      }
    };

    try {
      const org = await this.linkedInService.handleCallback({
        code: query.code,
        state: query.state,
        error: query.error,
        errorDescription: query.error_description,
      });
      this.logger.log(
        `LinkedIn callback succeeded — connected organization ${org.organizationUrn}`,
      );
      redirectTo('connected', org.organizationUrn);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LinkedIn connection failed';
      this.logger.error(
        `LinkedIn callback failed: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      redirectTo('error', message);
      return;
    }
  }

  @Get('organization')
  @UseGuards(FlexibleAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth('BearerAuth')
  @ApiOperation({ summary: 'Get the connected LinkedIn organization' })
  @ApiResponse({ status: 200, description: 'Connected organization (tokens masked)' })
  async getOrganization() {
    const org = await this.linkedInService.getOrganization();
    return this.linkedInService.toPublicView(org);
  }
}
