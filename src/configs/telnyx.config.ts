import { registerAs } from '@nestjs/config';

export default registerAs('telnyx', () => ({
  apiKey: process.env.TELNYX_API_KEY ?? '',
  /**
   * Telnyx Connection ID used for Call Control API outbound dialing.
   */
  connectionId: process.env.TELNYX_CONNECTION_ID ?? '',
  /**
   * Public DID purchased in Telnyx for outbound caller ID / inbound routing.
   */
  phoneNumber: process.env.TELNYX_PHONE_NUMBER ?? '',
  /**
   * Base64-encoded Ed25519 public key from Telnyx Mission Control Portal
   * (Account Settings → Public Key). Used to verify `telnyx-signature-ed25519` on
   * POST /webhook/telnyx/events. If unset, signature verification is skipped (logged loudly) —
   * set this in production so forged call-control events can't be posted to the webhook.
   */
  publicKey: process.env.TELNYX_PUBLIC_KEY ?? '',
}));
