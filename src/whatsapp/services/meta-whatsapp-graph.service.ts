import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { CompanyWhatsAppConfig } from '../../models/whatsapp/company-whatsapp-config.entity';
import { WhatsAppConfigService } from './whatsapp-config.service';

export interface MetaGraphPaging {
  cursors?: { before?: string; after?: string };
  next?: string;
  previous?: string;
}

export interface MetaGraphListResponse<T> {
  data: T[];
  paging?: MetaGraphPaging;
}

export interface MetaGraphErrorBody {
  message?: string;
  code?: number;
  type?: string;
  error_subcode?: number;
  fbtrace_id?: string;
}

@Injectable()
export class MetaWhatsAppGraphService {
  private readonly logger = new Logger(MetaWhatsAppGraphService.name);

  constructor(private readonly configService: WhatsAppConfigService) {}

  getApiVersion(config: CompanyWhatsAppConfig): string {
    return config.apiVersion?.trim() || 'v25.0';
  }

  graphUrl(config: CompanyWhatsAppConfig, path: string, query?: Record<string, string>): string {
    const version = this.getApiVersion(config);
    const base = path.startsWith('http')
      ? path
      : `https://graph.facebook.com/${version}/${path.replace(/^\//, '')}`;
    const url = new URL(base);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') {
          url.searchParams.set(k, v);
        }
      }
    }
    return url.toString();
  }

  async getJson<T>(
    config: CompanyWhatsAppConfig,
    path: string,
    query?: Record<string, string>,
  ): Promise<T> {
    const token = this.configService.getAccessToken(config);
    const url = this.graphUrl(config, path, query);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return this.parseResponse<T>(res, path);
  }

  async postJson<T>(
    config: CompanyWhatsAppConfig,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const token = this.configService.getAccessToken(config);
    const url = this.graphUrl(config, path);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res, path);
  }

  async getAllPages<T>(
    config: CompanyWhatsAppConfig,
    initialPath: string,
    initialQuery?: Record<string, string>,
  ): Promise<T[]> {
    const all: T[] = [];
    let url: string | null = this.graphUrl(config, initialPath, {
      ...initialQuery,
      limit: initialQuery?.limit ?? '100',
    });
    const token = this.configService.getAccessToken(config);
    let page = 0;

    while (url) {
      page++;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await this.parseResponse<MetaGraphListResponse<T>>(res, initialPath);
      all.push(...(json.data ?? []));
      url = json.paging?.next ?? null;
    }

    this.logger.log(`Meta Graph paginated fetch ${initialPath}: ${all.length} rows (${page} pages)`);
    return all;
  }

  private async parseResponse<T>(res: Response, path: string): Promise<T> {
    let json: T & { error?: MetaGraphErrorBody };
    try {
      json = (await res.json()) as T & { error?: MetaGraphErrorBody };
    } catch {
      throw new ServiceUnavailableException(`Meta API returned non-JSON response for ${path}`);
    }

    if (!res.ok || json.error) {
      throw this.toHttpException(json.error, res.status, path);
    }

    return json;
  }

  private toHttpException(
    error: MetaGraphErrorBody | undefined,
    status: number,
    path: string,
  ): HttpException {
    const code = error?.code;
    const msg = error?.message ?? `Meta Graph API request failed (${path})`;

    if (code === 190 || code === 102 || code === 463 || code === 467) {
      return new HttpException(
        `WhatsApp access token is invalid or expired. Update company WhatsApp configuration. (${msg})`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) {
      return new HttpException(
        `Meta API rate limit reached. Retry later. (${msg})`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (code === 100 || code === 131009) {
      return new BadRequestException(`Meta API: ${msg}`);
    }

    if (code === 200 || error?.type === 'OAuthException') {
      const hint = path.includes('message_templates')
        ? 'If token scopes are correct, check the template payload (library_template_name, button inputs; do not mix auto components with library copy).'
        : 'Ensure token has whatsapp_business_management on this WABA.';
      return new HttpException(`Meta API error: ${msg}. ${hint}`, HttpStatus.FORBIDDEN);
    }

    if (status >= 500) {
      return new ServiceUnavailableException(`Meta API unavailable: ${msg}`);
    }

    return new BadRequestException(`Meta API: ${msg}`);
  }
}
