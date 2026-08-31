import { Injectable } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';

import mozoConfig from '../../configs/mozo.config';
import { extractMozoErrorMessage } from '../utils/mozo-error.util';

/**
 * Client for Mozo's real direct venue/POS API — NOT the "App Store" marketplace API that
 * MozoTokenService talks to (see that class + src/mozo/README.md for the distinction).
 * Auth is a single static `X-API-Key` header (MOZO_DEVELOPER_AUTH_KEY), no token exchange.
 * Multi-tenant: every method takes the target `venueId` as a parameter. When omitted, falls
 * back to MOZO_SINGLE_TENANT_VENUE_ID (used by the in-process flow-tool call sites that don't
 * yet resolve a venue per company — see src/mozo/README.md). HTTP callers (MozoController)
 * always pass venueId explicitly and get a 400 if they don't.
 *
 * Confirmed live against https://testapiv2.themozo.net:
 *  - getVenue():       GET /v4/entity/venue/{id} — real venue data returned.
 *  - getMenu():        GET /v4/catalog/article/all/{id} — all articles (including
 *                      option/modifier sub-articles) with English `translations`, but only
 *                      bare `option_groups: [{id}]` references, no option details.
 *  - getActiveMenu():  GET /v4/catalog/article/active/{id} — only orderable (status:1) top-
 *                      level articles, each with `vat` (id/name/percentage) and inline
 *                      `options` (id, article_option_article_id, name, price) — but no
 *                      English translations. Verified against venue 28 ("MRWINSTON"), which
 *                      (unlike the empty venue 13) has a real configured item ("koffie" /
 *                      "Coffee", with "Met slagroom"/"Zonder slagroom" options). Combine both
 *                      calls (see flow-tools/mozo-order.tool.ts's menu merge) for a complete,
 *                      translated, price+option-aware view — neither call alone has everything.
 *  - getOrders():      POST /v2/process/order/entity/all/simple/{id} — 200, empty array.
 *
 * NOT confirmed:
 *  - getOrder(id) — best guess (GET /v2/process/order/{id}), never exercised against a
 *    real order because the test venue has none yet.
 *
 * NOT implemented — createOrder()/updateOrderStatus() throw rather than guess. Mozo's real
 * order creation is a multi-step checkout flow, not a single call:
 *   1. A guest_record.id (endpoint to create/obtain one not yet identified).
 *   2. A dineset_part.id — confirmed discoverable via GET /v4/entity/dineset/all/{venue_id}
 *      (for venue 13: dineset_parts[0].entity_id === 16).
 *   3. POST /v4/process/checkout-session/start with {guest_record, type, articles, amount}.
 *   4. POST /v4/process/checkout-session/start-order-session (or the v4
 *      order/create-for-checkout twin) with {checkout_session:{id}, venue:{entity_id},
 *      dineset_part:{id}, origin, total_order_value}.
 * See src/mozo/README.md "Order creation" for the full trail and what remains unresolved.
 */
@Injectable()
export class MozoApiService {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly defaultVenueId: string;

  constructor(configService: ConfigService) {
    const cfg = configService.getOrThrow<ConfigType<typeof mozoConfig>>('mozo');
    this.apiUrl = cfg.directApiUrl;
    this.apiKey = cfg.developerAuthKey;
    this.defaultVenueId = cfg.singleTenantVenueId;
  }

  async getVenue(venueId?: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v4/entity/venue/${encodeURIComponent(this.resolveVenueId(venueId))}`,
    );
  }

  async getMenu(venueId?: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v4/catalog/article/all/${encodeURIComponent(this.resolveVenueId(venueId))}`,
    );
  }

  /** See class docblock — has price/VAT/options that getMenu()'s article/all doesn't. */
  async getActiveMenu(venueId?: string): Promise<unknown> {
    return this.request(
      'GET',
      `/v4/catalog/article/active/${encodeURIComponent(this.resolveVenueId(venueId))}`,
    );
  }

  async getOrders(venueId?: string): Promise<unknown> {
    return this.request(
      'POST',
      `/v2/process/order/entity/all/simple/${encodeURIComponent(this.resolveVenueId(venueId))}`,
      {},
    );
  }

  /** Unconfirmed against a real order — see class docblock. */
  async getOrder(orderSessionId: string): Promise<unknown> {
    return this.request('GET', `/v2/process/order/${encodeURIComponent(orderSessionId)}`);
  }

  /** Not implemented — see class docblock for why this isn't a single-call operation. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async createOrder(_payload: Record<string, unknown>): Promise<unknown> {
    throw new Error(
      'Mozo order creation requires a multi-step checkout-session + dineset_part + ' +
        'guest_record flow that is not yet wired up here. See src/mozo/README.md ' +
        '"Order creation" for the confirmed prerequisite chain and what is still missing.',
    );
  }

  /** Not implemented — depends on the same unresolved checkout-session flow as createOrder. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async updateOrderStatus(_payload: Record<string, unknown>): Promise<unknown> {
    throw new Error(
      'Mozo order status updates depend on the same unresolved checkout-session flow as ' +
        'order creation. See src/mozo/README.md "Order creation".',
    );
  }

  private resolveVenueId(venueId?: string): string {
    const id = venueId || this.defaultVenueId;
    if (!id) {
      throw new Error('venue_id is required (no MOZO_SINGLE_TENANT_VENUE_ID fallback configured)');
    }
    return id;
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.apiKey) {
      throw new Error('MOZO_DEVELOPER_AUTH_KEY is not configured');
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        `Mozo API request to ${method} ${path} failed: ${extractMozoErrorMessage(json, response.status)}`,
      );
    }

    return json;
  }
}
