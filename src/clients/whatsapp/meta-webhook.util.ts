import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export type RequestWithRawBody = Request & { rawBody?: Buffer };

/** Exact UTF-8 bytes Meta signed — never use JSON.stringify(parsedBody). */
export function getMetaWebhookRawBody(req: RequestWithRawBody): Buffer | string | null {
  if (req.rawBody && Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) {
    return req.rawBody;
  }
  return null;
}

export function validateMetaWebhookSignature(
  appSecret: string,
  signatureHeader: string | undefined,
  rawBody: string | Buffer,
): boolean {
  if (!appSecret || !signatureHeader?.startsWith('sha256=')) {
    return false;
  }
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signatureHeader.slice(7);
  if (received.length !== expected.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
