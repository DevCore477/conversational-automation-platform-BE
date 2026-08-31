import type { WhatsAppMediaType } from './whatsapp.types';

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};

export function inferMetaMediaType(url: string): WhatsAppMediaType {
  const lower = url.split('?')[0]?.toLowerCase() ?? '';
  if (/\.(mp4|mov|webm|3gp)$/.test(lower)) {
    return 'video';
  }
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt)$/.test(lower)) {
    return 'document';
  }
  if (/\.(mp3|m4a|aac|amr|ogg|opus)$/.test(lower)) {
    return 'audio';
  }
  if (/\.wav$/i.test(lower)) {
    return 'document';
  }
  return 'image';
}

export function mimeTypeForMedia(type: WhatsAppMediaType, url: string): string {
  const ext = extensionFromUrl(url);
  if (ext && EXTENSION_MIME[ext]) {
    return EXTENSION_MIME[ext];
  }

  switch (type) {
    case 'audio':
      return 'audio/mpeg';
    case 'video':
      return 'video/mp4';
    case 'document':
      return 'application/pdf';
    case 'image':
    default:
      return 'image/jpeg';
  }
}

export function maxBytesForMediaType(type: WhatsAppMediaType): number {
  switch (type) {
    case 'audio':
      return MAX_AUDIO_BYTES;
    case 'video':
      return MAX_VIDEO_BYTES;
    case 'document':
      return MAX_DOCUMENT_BYTES;
    case 'image':
    default:
      return MAX_IMAGE_BYTES;
  }
}

export function filenameFromUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').pop();
    if (base?.trim()) {
      return decodeURIComponent(base);
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export function extensionFromUrl(url: string): string | null {
  const lower = url.split('?')[0]?.toLowerCase() ?? '';
  const match = lower.match(/\.([a-z0-9]+)$/i);
  return match?.[1] ?? null;
}

/** Audio/video/document CDN links often fail Meta's link fetch (131053) — upload via Media API. */
export function shouldUploadMediaViaApi(type: WhatsAppMediaType): boolean {
  return type === 'audio' || type === 'video' || type === 'document';
}

export function assertMediaTypeMatchesUrl(type: WhatsAppMediaType, url: string): void {
  const lower = url.split('?')[0]?.toLowerCase() ?? '';
  if (type === 'audio' && /\.wav$/i.test(lower)) {
    throw new Error(
      'WhatsApp Cloud API does not support WAV as audio. Convert to MP3/AAC/OGG (opus) or send as document.',
    );
  }
}
