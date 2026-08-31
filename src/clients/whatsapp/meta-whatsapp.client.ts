import { Logger } from '@nestjs/common';

import { normalizePhoneNumber } from '../../common/utils/phone.util';
import type { WhatsAppTokenProvider } from './whatsapp-token-provider';
import {
  assertMediaTypeMatchesUrl,
  filenameFromUrl,
  inferMetaMediaType,
  maxBytesForMediaType,
  mimeTypeForMedia,
  shouldUploadMediaViaApi,
} from './meta-media.util';
import { MetaTokenService } from './meta-token.service';
import { buildTemplateSendComponents } from '../../whatsapp/utils/whatsapp-template-send.util';
import type {
  SendWhatsAppMediaParams,
  SendWhatsAppTemplateParams,
  SendWhatsAppTextParams,
  WhatsAppMediaType,
  WhatsAppSendResult,
} from './whatsapp.types';

export class MetaWhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly type?: string,
    /** HTTP status from Meta Graph API when available (e.g. 401). */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'MetaWhatsAppApiError';
  }
}

interface MetaMessageResponse {
  messages?: { id: string }[];
  error?: { message: string; code?: number; type?: string };
}

interface MetaMediaUploadResponse {
  id?: string;
  error?: { message: string; code?: number; type?: string };
}

interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * WhatsApp Cloud API (Meta Graph API).
 * Uses MetaTokenService for auto-refresh on expired tokens.
 */
export class MetaWhatsAppClient {
  private readonly logger = new Logger(MetaWhatsAppClient.name);

  constructor(
    private readonly tokenService: WhatsAppTokenProvider,
    private readonly phoneNumberId: string,
    private readonly apiVersion: string,
    private readonly fromDisplay: string,
    private readonly defaultLanguage: string,
  ) {}

  private get messagesUrl(): string {
    return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  private get mediaUploadUrl(): string {
    return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/media`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.tokenService.getValidToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async bearerToken(): Promise<string> {
    return this.tokenService.getValidToken();
  }

  private async post(payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
    return this.postWithRetry(payload, false);
  }

  private async postWithRetry(
    payload: Record<string, unknown>,
    retried: boolean,
  ): Promise<WhatsAppSendResult> {
    try {
      return await this.postOnce(payload);
    } catch (error: unknown) {
      if (!retried && MetaTokenService.isAuthError(error)) {
        await this.tokenService.recoverFromAuthFailure();
        return this.postWithRetry(payload, true);
      }
      throw error;
    }
  }

  private async postOnce(payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
    this.logger.log(
      `Meta send type=${String(payload.type ?? 'unknown')} to=${String(payload.to ?? '')} phoneNumberId=${this.phoneNumberId}`,
    );
    this.logger.debug(`Meta send payload: ${JSON.stringify(payload)}`);

    const res = await fetch(this.messagesUrl, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as MetaMessageResponse;
    if (!res.ok || data.error) {
      const err = data.error;
      this.logger.warn(
        `Meta send failed type=${String(payload.type)} code=${err?.code} message=${err?.message}`,
      );
      throw new MetaWhatsAppApiError(
        err?.message ?? res.statusText,
        err?.code,
        err?.type,
        res.status,
      );
    }

    const id = data.messages?.[0]?.id ?? '';
    const to = String(payload.to ?? '');
    this.logger.log(`Meta send accepted wamid=${id} type=${String(payload.type)} to=${to}`);
    return {
      messageSid: id,
      status: 'accepted',
      to,
      from: this.fromDisplay,
    };
  }

  private async graphGet(path: string): Promise<Response> {
    return this.graphGetWithRetry(path, false);
  }

  private async graphGetWithRetry(path: string, retried: boolean): Promise<Response> {
    const url = path.startsWith('http')
      ? path
      : `https://graph.facebook.com/${this.apiVersion}/${path}`;
    try {
      const res = await fetch(url, { headers: await this.authHeaders() });
      if (!retried && res.status === 401) {
        await this.tokenService.recoverFromAuthFailure();
        return await this.graphGetWithRetry(path, true);
      }
      return res;
    } catch (error: unknown) {
      if (!retried && MetaTokenService.isAuthError(error)) {
        await this.tokenService.recoverFromAuthFailure();
        return this.graphGetWithRetry(path, true);
      }
      throw error;
    }
  }

  private toRecipient(e164: string): string {
    const normalized = normalizePhoneNumber(e164);
    if (!normalized) {
      throw new Error('Invalid phone number for WhatsApp');
    }
    return normalized.replace(/^\+/, '');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.graphGet(this.phoneNumberId);
      return res.ok;
    } catch {
      return false;
    }
  }

  async sendText(params: SendWhatsAppTextParams): Promise<WhatsAppSendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.toRecipient(params.to),
      type: 'text',
      text: { body: params.body, preview_url: false },
    });
  }

  async sendMedia(params: SendWhatsAppMediaParams): Promise<WhatsAppSendResult> {
    const link = params.mediaUrl[0]?.trim();
    if (!link) {
      throw new Error('At least one media URL is required');
    }
    if (!/^https:\/\//i.test(link)) {
      throw new MetaWhatsAppApiError(
        'Media URL must be a publicly accessible HTTPS link (Meta Cloud API requirement)',
        100,
      );
    }

    const type = params.mediaType ?? inferMetaMediaType(link);
    try {
      assertMediaTypeMatchesUrl(type, link);
    } catch (err) {
      throw new MetaWhatsAppApiError((err as Error).message, 100);
    }

    const useUpload = params.uploadViaMediaApi !== false && shouldUploadMediaViaApi(type);
    const mediaPayload: Record<string, unknown> = useUpload
      ? { id: await this.uploadMediaForSend(link, type) }
      : this.buildLinkMediaPayload(link, type, params.body);

    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.toRecipient(params.to),
      type,
      [type]: mediaPayload,
    });
  }

  private buildLinkMediaPayload(
    link: string,
    type: WhatsAppMediaType,
    body?: string,
  ): Record<string, unknown> {
    const mediaPayload: Record<string, unknown> = { link };
    const caption = body?.trim();
    if (caption && (type === 'image' || type === 'video' || type === 'document')) {
      mediaPayload.caption = caption;
    }
    if (type === 'document') {
      const filename = filenameFromUrl(link, 'document');
      mediaPayload.filename = filename;
    }
    return mediaPayload;
  }

  /**
   * Upload media to Meta then return media id for message send.
   * Avoids error 131053 when Meta cannot fetch CDN URLs directly.
   */
  private async uploadMediaForSend(sourceUrl: string, type: WhatsAppMediaType): Promise<string> {
    const mimeType = mimeTypeForMedia(type, sourceUrl);

    const viaUrl = await this.tryUploadMediaByMetaUrl(sourceUrl, mimeType);
    if (viaUrl) {
      this.logger.log(`Meta media uploaded via URL reference id=${viaUrl} type=${mimeType}`);
      return viaUrl;
    }

    const downloaded = await this.downloadMedia(sourceUrl, type, mimeType);
    const viaMultipart = await this.uploadMediaMultipart(
      downloaded.buffer,
      downloaded.mimeType,
      downloaded.filename,
    );
    this.logger.log(
      `Meta media uploaded via multipart id=${viaMultipart} bytes=${downloaded.buffer.length} mime=${downloaded.mimeType}`,
    );
    return viaMultipart;
  }

  private async tryUploadMediaByMetaUrl(
    sourceUrl: string,
    mimeType: string,
  ): Promise<string | null> {
    try {
      const token = await this.bearerToken();
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mimeType);
      form.append('url', sourceUrl);

      const res = await fetch(this.mediaUploadUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = (await res.json()) as MetaMediaUploadResponse;
      if (!res.ok || data.error || !data.id) {
        this.logger.debug(
          `Meta media URL upload failed: ${data.error?.message ?? res.status} — will download and upload bytes`,
        );
        return null;
      }
      return data.id;
    } catch (err) {
      this.logger.debug(`Meta media URL upload error: ${(err as Error).message}`);
      return null;
    }
  }

  private async downloadMedia(
    sourceUrl: string,
    type: WhatsAppMediaType,
    declaredMime: string,
  ): Promise<DownloadedMedia> {
    const res = await fetch(sourceUrl, {
      headers: {
        Accept: '*/*',
        'User-Agent': 'HexaAI-WhatsApp/1.0',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new MetaWhatsAppApiError(
        `Could not download media from URL (HTTP ${res.status}). Ensure the link is public.`,
        res.status,
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const maxBytes = maxBytesForMediaType(type);
    if (buffer.length > maxBytes) {
      throw new MetaWhatsAppApiError(
        `Media file is too large (${buffer.length} bytes). Max for ${type} is ${maxBytes} bytes.`,
        100,
      );
    }

    if (buffer.length === 0) {
      throw new MetaWhatsAppApiError('Media URL returned an empty file', 100);
    }

    const headerMime = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    let mimeType = declaredMime;
    if (headerMime && headerMime !== 'application/octet-stream' && headerMime !== 'binary/octet-stream') {
      mimeType = headerMime;
    }

    const filename = filenameFromUrl(sourceUrl, defaultFilename(type, mimeType));

    this.logger.debug(
      `Downloaded media ${buffer.length} bytes mime=${mimeType} filename=${filename} from ${sourceUrl}`,
    );

    return { buffer, mimeType, filename };
  }

  private async uploadMediaMultipart(
    buffer: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<string> {
    const token = await this.bearerToken();
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

    const res = await fetch(this.mediaUploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const data = (await res.json()) as MetaMediaUploadResponse;
    if (!res.ok || data.error || !data.id) {
      throw new MetaWhatsAppApiError(
        data.error?.message ??
          `Meta media upload failed (${res.status}). Check format and size for WhatsApp supported types.`,
        data.error?.code,
        data.error?.type,
        res.status,
      );
    }

    return data.id;
  }

  async sendTemplate(params: SendWhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    const languageCode = params.languageCode ?? this.defaultLanguage;

    const components =
      params.components && params.components.length > 0
        ? params.components
        : buildTemplateSendComponents({
            parameters: params.parameters,
            contentVariables: params.contentVariables,
            templateComponents: params.templateComponents,
          });

    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.toRecipient(params.to),
      type: 'template',
      template: {
        name: params.templateName ?? params.contentSid,
        language: { code: languageCode },
        components,
      },
    });
  }

  async sendPayload(payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
    return this.post(payload);
  }

  async getMessageStatus(_messageSid: string): Promise<string> {
    return 'unknown';
  }

  async markMessageAsRead(inboundMessageId: string): Promise<void> {
    await this.post({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: inboundMessageId,
    });
  }

  /** Resolve a Meta media id (from an inbound webhook) to its short-lived CDN URL + metadata. */
  async getInboundMediaMeta(mediaId: string): Promise<InboundMediaMeta> {
    const res = await this.graphGet(mediaId);
    const data = (await res.json()) as InboundMediaMeta & { error?: MetaMessageResponse['error'] };
    if (!res.ok || data.error || !data.url) {
      throw new MetaWhatsAppApiError(
        data.error?.message ?? `Could not resolve media id ${mediaId} (HTTP ${res.status})`,
        data.error?.code,
        data.error?.type,
        res.status,
      );
    }
    return { url: data.url, mime_type: data.mime_type, file_size: data.file_size, sha256: data.sha256 };
  }

  /** Download an inbound media attachment's bytes by Meta media id (Graph API media URLs require the bearer token). */
  async downloadInboundMedia(mediaId: string): Promise<DownloadedMedia & { sha256?: string }> {
    const meta = await this.getInboundMediaMeta(mediaId);
    const token = await this.bearerToken();
    const res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new MetaWhatsAppApiError(
        `Could not download inbound media ${mediaId} (HTTP ${res.status})`,
        res.status,
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
      throw new MetaWhatsAppApiError(`Inbound media ${mediaId} downloaded as an empty file`, 100);
    }

    const mimeType = meta.mime_type ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
    const filename = filenameFromUrl(meta.url, defaultFilenameForMime(mimeType));

    return { buffer, mimeType, filename, sha256: meta.sha256 };
  }
}

interface InboundMediaMeta {
  url: string;
  mime_type?: string;
  file_size?: number;
  sha256?: string;
}

function defaultFilenameForMime(mimeType: string): string {
  if (mimeType.includes('pdf')) return 'document.pdf';
  if (mimeType.includes('word')) return 'document.docx';
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'document.xlsx';
  if (mimeType.includes('presentation')) return 'document.pptx';
  if (mimeType.startsWith('audio/')) return mimeType.includes('ogg') ? 'audio.ogg' : 'audio.mp3';
  if (mimeType.startsWith('video/')) return 'video.mp4';
  if (mimeType.startsWith('image/')) return mimeType.includes('webp') ? 'sticker.webp' : 'image.jpg';
  return 'file';
}

function defaultFilename(type: WhatsAppMediaType, mimeType: string): string {
  if (type === 'audio') {
    if (mimeType.includes('ogg')) {
      return 'audio.ogg';
    }
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
      return 'audio.m4a';
    }
    return 'audio.mp3';
  }
  if (type === 'video') {
    return 'video.mp4';
  }
  if (type === 'document') {
    return 'document.pdf';
  }
  return 'image.jpg';
}
