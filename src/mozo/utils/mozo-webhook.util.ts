import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export type RequestWithRawBody = Request & { rawBody?: Buffer };

/** Exact bytes Mozo signed — never use JSON.stringify(parsedBody). Populated globally via `rawBody: true` in main.ts. */
export function getMozoWebhookRawBody(req: RequestWithRawBody): Buffer | null {
  if (req.rawBody && Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) {
    return req.rawBody;
  }
  return null;
}

/** Mozo signs deliveries as HMAC_SHA256(webhookSecret, `${timestamp}.${rawBody}`), hex digest. */
export function verifyMozoWebhookSignature(
  webhookSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
}
