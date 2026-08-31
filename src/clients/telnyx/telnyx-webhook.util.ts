import { createPublicKey, verify } from 'crypto';
import type { Request } from 'express';

export type RequestWithRawBody = Request & { rawBody?: Buffer };

/** Exact bytes Telnyx signed — never use JSON.stringify(parsedBody), key order/whitespace differs. */
export function getTelnyxWebhookRawBody(req: RequestWithRawBody): Buffer | null {
  if (req.rawBody && Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) {
    return req.rawBody;
  }
  return null;
}

/** Reject events older than this many seconds even with a valid signature (anti-replay). */
const MAX_TIMESTAMP_SKEW_SECS = 300;

function ed25519PublicKeyFromBase64Raw(base64RawKey: string) {
  const raw = Buffer.from(base64RawKey, 'base64');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Verify Telnyx's `telnyx-signature-ed25519` header against the raw request body.
 * @see https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks#verifying-webhook-signatures
 */
export function verifyTelnyxWebhookSignature(
  publicKeyBase64: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  rawBody: Buffer,
): boolean {
  if (!publicKeyBase64 || !signatureHeader || !timestampHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const skewSecs = Math.abs(Date.now() / 1000 - timestamp);
  if (skewSecs > MAX_TIMESTAMP_SKEW_SECS) {
    return false;
  }

  try {
    const publicKey = ed25519PublicKeyFromBase64Raw(publicKeyBase64);
    const signedPayload = Buffer.concat([
      Buffer.from(`${timestampHeader}|`, 'utf8'),
      rawBody,
    ]);
    const signature = Buffer.from(signatureHeader, 'base64');
    return verify(null, signedPayload, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Telnyx Call Control webhooks use `incoming` / `outgoing` on the payload.
 * Some integrations also send `inbound` / `outbound`.
 */
export function isTelnyxInboundDirection(direction: string | undefined): boolean {
  if (!direction) return false;
  const d = direction.toLowerCase();
  return d === 'incoming' || d === 'inbound';
}

export function isTelnyxOutboundDirection(direction: string | undefined): boolean {
  if (!direction) return false;
  const d = direction.toLowerCase();
  return d === 'outgoing' || d === 'outbound';
}

/** Inbound PSTN legs are parked until answered (when direction is omitted). */
export function isTelnyxInboundInitiated(params: {
  direction?: string;
  state?: string;
}): boolean {
  if (isTelnyxInboundDirection(params.direction)) return true;
  if (isTelnyxOutboundDirection(params.direction)) return false;
  return params.state === 'parked';
}
