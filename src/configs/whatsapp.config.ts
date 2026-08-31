import { registerAs } from '@nestjs/config';

export type WhatsAppProvider = 'meta' | 'twilio';

export default registerAs('whatsapp', () => ({
  /** `meta` (WhatsApp Cloud API, default) or `twilio` */
  provider: (process.env.WHATSAPP_PROVIDER ?? 'meta') as WhatsAppProvider,
  /** Display / business number (E.164), optional for Meta */
  fromNumber: process.env.WHATSAPP_FROM_NUMBER ?? '',
  /** Meta Cloud API — required when provider=meta (seed; auto-refreshed when APP_ID+SECRET set) */
  metaAccessToken: process.env.WHATSAPP_META_ACCESS_TOKEN ?? '',
  /** Meta App ID (App settings → Basic) — required for automatic token refresh */
  metaAppId:
    process.env.WHATSAPP_APP_ID ??
    process.env.WHATSAPP_META_APP_ID ??
    process.env.META_APP_ID ??
    '',
  /** Meta App Secret — required for automatic token refresh (not the access token) */
  metaAppSecret: process.env.WHATSAPP_META_APP_SECRET ?? process.env.META_APP_SECRET ?? '',
  metaPhoneNumberId: process.env.WHATSAPP_META_PHONE_NUMBER_ID ?? '',
  metaApiVersion: process.env.WHATSAPP_META_API_VERSION ?? 'v25.0',
  /** Webhook verify token (Meta App Dashboard → WhatsApp → Configuration) */
  metaVerifyToken: process.env.WHATSAPP_META_VERIFY_TOKEN ?? '',
  /** Skip X-Hub-Signature-256 check (local/ngrok only — never in production) */
  metaSkipWebhookSignature: process.env.WHATSAPP_META_SKIP_SIGNATURE === 'true',
  /** Default template language code (ISO 639, e.g. en, en_US, ar) */
  metaDefaultLanguage: process.env.WHATSAPP_META_DEFAULT_LANGUAGE ?? 'en',
  /** Twilio-only: validate X-Twilio-Signature on status callbacks */
  validateTwilioWebhookSignature:
    process.env.WHATSAPP_VALIDATE_TWILIO_WEBHOOK_SIGNATURE !== 'false',
  /** Max recipients per bulk campaign */
  bulkMaxRecipients: Number(process.env.WHATSAPP_BULK_MAX_RECIPIENTS ?? 5000),
  /** Default delay between bulk messages (ms) — Meta rate limits */
  bulkDefaultDelayMs: Number(process.env.WHATSAPP_BULK_DELAY_MS ?? 800),
  bulkMaxDelayMs: Number(process.env.WHATSAPP_BULK_MAX_DELAY_MS ?? 10000),
  /** Queue worker poll interval (ms) */
  queuePollIntervalMs: Number(process.env.WHATSAPP_QUEUE_POLL_MS ?? 2000),
  /** Jobs claimed per worker tick */
  queueBatchSize: Number(process.env.WHATSAPP_QUEUE_BATCH_SIZE ?? 20),
  queueWorkerId: process.env.WHATSAPP_QUEUE_WORKER_ID ?? 'worker-1',
  /** Retry backoff base (ms) */
  queueRetryBackoffMs: Number(process.env.WHATSAPP_QUEUE_RETRY_MS ?? 5000),
  /** BullMQ outbound defaults (overridden per company config) */
  maxMessagesPerSecond: Number(process.env.WHATSAPP_MAX_MESSAGES_PER_SECOND ?? 5),
  maxMessagesPerMinute: Number(process.env.WHATSAPP_MAX_MESSAGES_PER_MINUTE ?? 80),
  maxRetries: Number(process.env.WHATSAPP_MAX_RETRIES ?? 5),
  retryBackoffMs: Number(process.env.WHATSAPP_RETRY_BACKOFF_MS ?? 5000),
  freeformWindowHours: Number(process.env.WHATSAPP_FREEFORM_WINDOW_HOURS ?? 24),
  /**
   * When outside the 24h window, single text sends use this approved utility template
   * with the message body as the first {{1}} parameter.
   */
  defaultOutboundTemplateName: process.env.WHATSAPP_DEFAULT_OUTBOUND_TEMPLATE_NAME ?? '',
  defaultOutboundTemplateLanguage: process.env.WHATSAPP_DEFAULT_OUTBOUND_TEMPLATE_LANGUAGE ?? '',
  /** AES key for company token encryption at rest (32+ chars recommended) */
  tokenEncryptionKey: process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY ?? '',
  /**
   * Local dev only: allow global WHATSAPP_META_* when company config missing.
   * Never enable in production multi-tenant deployments.
   */
  allowGlobalMetaFallback: process.env.WHATSAPP_ALLOW_GLOBAL_META_FALLBACK === 'true',

  // --- Multimodal media processing pipeline (BullMQ) ---
  /** Max attempts for the media-understanding job before giving up (still replies without it). */
  mediaMaxRetries: Number(process.env.WHATSAPP_MEDIA_MAX_RETRIES ?? 3),
  mediaRetryBackoffMs: Number(process.env.WHATSAPP_MEDIA_RETRY_BACKOFF_MS ?? 4000),
  /** Concurrent media jobs processed at once (vision/transcription/ffmpeg calls are heavier than sends). */
  mediaWorkerConcurrency: Number(process.env.WHATSAPP_MEDIA_WORKER_CONCURRENCY ?? 4),
  /** Videos longer than this are stored but not frame/audio-processed. */
  mediaMaxVideoDurationSeconds: Number(process.env.WHATSAPP_MEDIA_MAX_VIDEO_SECONDS ?? 180),
  /** Documents larger than this are marked unsupported rather than attempted. */
  mediaMaxDocumentBytes: Number(process.env.WHATSAPP_MEDIA_MAX_DOCUMENT_BYTES ?? 25 * 1024 * 1024),
  /** How many recent messages feed the AI reply's recency-window context. */
  contextRecencyWindow: Number(process.env.WHATSAPP_CONTEXT_RECENCY_WINDOW ?? 40),
  /** How many older media rows (bounded per-conversation) are candidates for semantic retrieval. */
  contextSemanticCandidatePool: Number(process.env.WHATSAPP_CONTEXT_SEMANTIC_POOL ?? 300),
  /** How many semantically-relevant older media items get spliced into context beyond the recency window. */
  contextSemanticTopN: Number(process.env.WHATSAPP_CONTEXT_SEMANTIC_TOP_N ?? 3),
  /**
   * Dedicated S3 bucket for downloaded WhatsApp media (images/video/audio/documents). Falls back
   * to the shared `S3_BUCKET_NAME` bucket when unset — same AWS account/region/credentials either way.
   */
  mediaBucketName: process.env.WHATSAPP_BUCKET_NAME ?? '',
  /** Key prefix under the media bucket, e.g. "whatsapp-media/" — company/conversation/uuid appended per file. */
  mediaFolderPrefix: process.env.WHATSAPP_FOLDER_PREFIX ?? 'whatsapp-media/',
}));
