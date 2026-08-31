import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { getMetaWebhookRawBody, type RequestWithRawBody } from '../clients/whatsapp/meta-webhook.util';
import { WhatsAppMetaWebhookVerifyService } from './services/whatsapp-meta-webhook-verify.service';
import { WhatsAppService } from './whatsapp.service';
import { extractStatusEventsFromWebhook } from '../clients/whatsapp/meta-webhook-payload.util';

/**
 * Meta WhatsApp Cloud API webhooks.
 *
 * In Meta App Dashboard → WhatsApp → Configuration:
 * - Callback URL: {WEBHOOK_BASE_URL}/webhook/whatsapp
 * - Verify token: same as WHATSAPP_META_VERIFY_TOKEN
 * - Subscribe to: messages, message status (and others as needed)
 *
 * Signature: set WHATSAPP_META_APP_SECRET to App Secret (App settings → Basic),
 * not the WhatsApp access token.
 */
@ApiExcludeController()
@Controller('webhook/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly webhookVerify: WhatsAppMetaWebhookVerifyService,
  ) {}

  @Get()
  verifyMeta(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ): void {
    if (this.whatsAppService.verifyMetaWebhook(mode, token) && challenge) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    this.logger.warn('Meta webhook verification failed (check WHATSAPP_META_VERIFY_TOKEN)');
    res.status(403).send('Forbidden');
  }

  @Post()
  @HttpCode(200)
  async handleMeta(
    @Body() body: Record<string, unknown>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() req: RequestWithRawBody,
  ): Promise<{ received: boolean }> {
    const rawBody = getMetaWebhookRawBody(req);
    if (!rawBody) {
      this.logger.error(
        'Meta webhook: raw body missing. Restart the server after enabling rawBody in main.ts.',
      );
      throw new ForbiddenException('Webhook raw body unavailable for signature verification');
    }

    const valid = await this.webhookVerify.validateSignature(signature, rawBody, body);
    if (!valid) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    const statusEvents = extractStatusEventsFromWebhook(body);
    if (statusEvents.length > 0) {
      this.logger.log(
        `Meta webhook POST: ${statusEvents.length} status event(s) [${statusEvents.map(e => `${e.status.id}:${e.status.status}`).join(', ')}]`,
      );
    }

    await this.whatsAppService.handleMetaWebhook(
      body as Parameters<WhatsAppService['handleMetaWebhook']>[0],
    );

    return { received: true };
  }

  /** Twilio-only: POST {WEBHOOK_BASE_URL}/webhook/whatsapp/twilio/status */
  @Post('twilio/status')
  handleTwilioStatus(
    @Body() body: Record<string, string>,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Req() req: Request,
  ): { received: boolean } {
    const proto = req.get('x-forwarded-proto') ?? req.protocol;
    const host = req.get('x-forwarded-host') ?? req.get('host') ?? '';
    const url = `${proto}://${host}${req.originalUrl}`;

    if (!this.whatsAppService.validateTwilioWebhook(signature, url, body)) {
      this.logger.warn('Rejected Twilio WhatsApp status webhook: invalid signature');
      throw new ForbiddenException('Invalid webhook signature');
    }

    this.whatsAppService.handleTwilioStatusWebhook(body);
    return { received: true };
  }
}
