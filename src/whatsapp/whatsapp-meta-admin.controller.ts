import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { MetaTokenService } from '../clients/whatsapp/meta-token.service';
import { FlexibleAuthGuard } from '../guards';

@ApiTags('WhatsApp Admin')
@UseGuards(FlexibleAuthGuard)
@ApiBearerAuth('BearerAuth')
@Controller('whatsapp/admin')
export class WhatsAppMetaAdminController {
  constructor(private readonly metaTokenService: MetaTokenService) {}

  @Get('meta-token/expiry')
  @ApiOperation({
    summary:
      'Fetch live token expiry from Meta debug_token, sync expiresAt to DB, return hours/seconds remaining',
  })
  async tokenExpiry() {
    const status = await this.metaTokenService.fetchExpiryAndSyncDb();
    return {
      ok: true,
      message: 'Expiry fetched from Meta and synced to database',
      ...status,
    };
  }

  @Get('meta-token/status')
  @ApiOperation({
    summary: 'Meta token status (live expiry + DB sync)',
  })
  tokenStatus() {
    return this.metaTokenService.getTokenStatus(true);
  }

  @Post('meta-token/sync-env-token')
  @ApiOperation({
    summary: 'Import env token, exchange for long-lived token, update expiresAt in DB',
  })
  async syncEnvToken() {
    const token = await this.metaTokenService.forceSyncFromEnv();
    const status = await this.metaTokenService.fetchExpiryAndSyncDb();
    return {
      ok: true,
      message: 'Token synced from env and exchanged with Meta',
      tokenSuffix: token.slice(-8),
      status,
    };
  }

  @Post('meta-token/refresh-now')
  @ApiOperation({
    summary: 'Force proactive exchange now (while current token is still valid)',
  })
  async refreshNow() {
    const token = await this.metaTokenService.refreshToken(true);
    const status = await this.metaTokenService.fetchExpiryAndSyncDb();
    return {
      ok: true,
      tokenSuffix: token.slice(-8),
      status,
    };
  }
}
