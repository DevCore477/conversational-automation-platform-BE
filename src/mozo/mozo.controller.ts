import { Controller, Get, Logger, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import type { Request, Response } from 'express';

import { MozoIframeSessionGuard } from './guards/mozo-iframe-session.guard';
import { MozoApiService } from './services/mozo-api.service';
import { MozoTokenService } from './services/mozo-token.service';
import { MozoVenueLinkService } from './services/mozo-venue-link.service';
import {
  getMozoWebhookRawBody,
  verifyMozoWebhookSignature,
  type RequestWithRawBody,
} from './utils/mozo-webhook.util';
import { AuthService } from '../auth/auth.service';
import authConfig from '../configs/auth.config';
import mozoConfig from '../configs/mozo.config';
import { DashboardService } from '../dashboard/dashboard.service';

const EMBED_REDIRECT_TARGETS = new Set(['/dashboard', '/calls']);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bridges HexaAI to the Mozo App Store — folded in from the standalone `mozo-widget/backend`
 * reference implementation.
 * - `/mozo/hexaai/activity` and `/mozo/hexaai/embed-session` always resolve to the one
 *   HexaAI company configured via MOZO_SINGLE_TENANT_COMPANY_ID (no per-venue API key
 *   lookup — that trust model was walked back in favor of the shared bridge secret
 *   backing /auth/embedded-session). Both are gated by `MozoIframeSessionGuard` — see its
 *   docblock for exactly what is and isn't verified about the caller.
 * - `/mozo/menu`, `/mozo/orders`, `/mozo/orders/:id`, `/mozo/orders/status`, `/mozo/venue`
 *   (the reverse direction — reading/writing Mozo's own data) are multi-tenant: each request
 *   must pass `venue_id` (query string) and is resolved against that Mozo venue, not a fixed
 *   env value — see `requireVenueId`. `POST /mozo/orders` and `PUT /mozo/orders/status`'s
 *   payloads are unverified passthroughs — see MozoApiService.
 */
@Controller('mozo')
export class MozoController {
  private readonly logger = new Logger(MozoController.name);
  private readonly webhookSecret: string;
  private readonly frontendBaseUrl: string;
  private readonly singleTenantCompanyId: string;

  constructor(
    private readonly mozoTokenService: MozoTokenService,
    private readonly venueLinkService: MozoVenueLinkService,
    private readonly mozoApiService: MozoApiService,
    private readonly dashboardService: DashboardService,
    private readonly authService: AuthService,
    configService: ConfigService,
  ) {
    const mozoCfg = configService.getOrThrow<ConfigType<typeof mozoConfig>>('mozo');
    this.webhookSecret = mozoCfg.webhookSecret;
    this.singleTenantCompanyId = mozoCfg.singleTenantCompanyId;
    this.frontendBaseUrl =
      configService.getOrThrow<ConfigType<typeof authConfig>>('auth').frontendBaseUrl ??
      'http://localhost:3000';
  }

  @Get('healthz')
  healthz() {
    return { ok: true };
  }

  @Post('auth/token')
  async mozoAuthToken(@Req() req: Request, @Res() res: Response) {
    const venueId = this.requireVenueId(req, res);
    if (!venueId) return;
    try {
      await this.mozoTokenService.getAppAccessToken(venueId);
      res.status(200).json({ connected: true, venue_id: venueId });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  @Get('menu')
  async menu(@Req() req: Request, @Res() res: Response) {
    const venueId = this.requireVenueId(req, res);
    if (!venueId) return;

    try {
      const data = await this.mozoApiService.getMenu(venueId);
      res.status(200).json(data);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  @Get('orders')
  async orders(@Req() req: Request, @Res() res: Response) {
    const venueId = this.requireVenueId(req, res);
    if (!venueId) return;

    try {
      const data = await this.mozoApiService.getOrders(venueId);
      res.status(200).json(data);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  @Get('orders/:orderSessionId')
  async order(@Param('orderSessionId') orderSessionId: string, @Res() res: Response) {
    try {
      const data = await this.mozoApiService.getOrder(orderSessionId);
      res.status(200).json(data);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  /** Payload is passed through as-is to Mozo — see MozoApiService.createOrder's docblock. */
  @Post('orders')
  async createOrder(@Req() req: Request, @Res() res: Response) {
    const payload = req.body as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'A JSON order payload is required' });
      return;
    }

    try {
      const data = await this.mozoApiService.createOrder(payload);
      res.status(201).json(data);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  /** Payload is passed through as-is to Mozo — see MozoApiService.updateOrderStatus's docblock. */
  @Put('orders/status')
  async updateOrderStatus(@Req() req: Request, @Res() res: Response) {
    const payload = req.body as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'A JSON status payload is required' });
      return;
    }

    try {
      const data = await this.mozoApiService.updateOrderStatus(payload);
      res.status(200).json(data);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  @Get('venue')
  async venue(@Req() req: Request, @Res() res: Response) {
    const venueId = this.requireVenueId(req, res);
    if (!venueId) return;

    try {
      const data = await this.mozoApiService.getVenue(venueId);
      res.status(200).json(data);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  @Post('hexaai/connect')
  async hexaaiConnect(@Req() req: Request, @Res() res: Response) {
    const venueId = this.requireVenueId(req, res);
    if (!venueId) return;

    const apiKey = (req.body as { api_key?: unknown } | undefined)?.api_key;
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      res.status(400).json({ error: 'api_key is required' });
      return;
    }

    await this.venueLinkService.link(venueId, apiKey);
    res.status(200).json({ connected: true, venue_id: venueId });
  }

  @Get('hexaai/activity')
  @UseGuards(MozoIframeSessionGuard)
  async hexaaiActivity(@Req() req: Request, @Res() res: Response) {
    if (!this.singleTenantCompanyId) {
      res.status(400).json({ error: 'MOZO_SINGLE_TENANT_COMPANY_ID is not configured' });
      return;
    }

    try {
      const rawLimit = req.query.limit;
      const limit = typeof rawLimit === 'string' && rawLimit !== '' ? parseInt(rawLimit, 10) : 20;
      const data = await this.dashboardService.getRecentActivity(limit, this.singleTenantCompanyId);
      res.status(200).json(data);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  @Get('hexaai/embed-session')
  @UseGuards(MozoIframeSessionGuard)
  async hexaaiEmbedSession(@Req() req: Request, @Res() res: Response) {
    const requestedRedirect = req.query.redirect;
    const redirectPath =
      typeof requestedRedirect === 'string' && EMBED_REDIRECT_TARGETS.has(requestedRedirect)
        ? requestedRedirect
        : '/dashboard';

    try {
      const session = await this.authService.embeddedSession();
      const embedUrl = `${this.frontendBaseUrl}/mozo-embed?token=${encodeURIComponent(session.accessToken)}&redirect=${encodeURIComponent(redirectPath)}`;
      res.status(200).json({ embedUrl });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  }

  @Post('webhooks/mozo')
  mozoWebhook(@Req() req: RequestWithRawBody, @Res() res: Response) {
    if (!this.webhookSecret) {
      this.logger.warn('MOZO_WEBHOOK_SECRET is not set; refusing delivery');
      res.status(500).json({ error: 'webhook secret not configured' });
      return;
    }

    const timestamp = this.headerValue(req, 'x-mozo-timestamp');
    const signature = this.headerValue(req, 'x-mozo-signature');
    const eventType = this.headerValue(req, 'x-mozo-event');

    const rawBody = getMozoWebhookRawBody(req);
    if (
      !rawBody ||
      !signature ||
      !verifyMozoWebhookSignature(
        this.webhookSecret,
        timestamp,
        rawBody.toString('utf8'),
        signature,
      )
    ) {
      this.logger.warn(`invalid signature for event=${eventType}`);
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // ignore — logged without a parsed payload below
    }
    this.logger.log(`received event=${eventType} payload=${JSON.stringify(payload)}`);

    res.status(200).json({ received: true });
  }

  private headerValue(req: Request, name: string): string {
    const value = req.headers[name];
    return typeof value === 'string' ? value : '';
  }

  /** Mirrors the tested standalone bridge: accepts venue_id from either the body or the query string. */
  private requireVenueId(req: Request, res: Response): string | null {
    const bodyVenueId = (req.body as { venue_id?: unknown } | undefined)?.venue_id;
    const queryVenueId = req.query.venue_id;
    const venueId =
      typeof bodyVenueId === 'string' && bodyVenueId !== '' ? bodyVenueId : queryVenueId;
    if (typeof venueId !== 'string' || venueId === '') {
      res.status(400).json({ error: 'venue_id is required' });
      return null;
    }
    return venueId;
  }
}
