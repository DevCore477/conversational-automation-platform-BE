import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER ?? '+18723352047',
  /** Default/generic Telnyx DID, used for every company except those with an override below. */
  telnyxPhoneNumber: process.env.TELNYX_PHONE_NUMBER ?? '',
  /**
   * Netherlands Telnyx DID, used only for the company identified by `telnyxNlCompanyId`. See
   * `TelnyxPhoneNumberService` for the full company -> number resolution.
   */
  telnyxPhoneNumberNl: process.env.TELNYX_PHONE_NUMBER_NL ?? '',
  /**
   * Company UUID that must always dial out from `telnyxPhoneNumberNl` instead of the generic
   * `telnyxPhoneNumber`. Unset means no company gets the Netherlands number.
   */
  telnyxNlCompanyId: process.env.TELNYX_NL_COMPANY_ID ?? '',
  /**
   * Caller ID for Telnyx `transfer` (must be a Telnyx number or a verified outbound profile).
   * If unset, falls back to the company-resolved Telnyx number (see `TelnyxPhoneNumberService`)
   * then `twilioPhoneNumber`. If still empty, `from` is omitted (Telnyx default).
   */
  telnyxTransferFromNumber: process.env.TELNYX_TRANSFER_FROM_NUMBER ?? '',
  /**
   * Company UUID that owns platform-wide resources (e.g. default inbound conversation flows
   * linked to global call scripts). Set this to the Hexa AI / platform tenant in the DB.
   */
  platformCompanyId: process.env.PLATFORM_COMPANY_ID ?? '',
  inboundCallScript:
    process.env.INBOUND_CALL_SCRIPT ??
    'You are a helpful AI assistant. Greet the caller warmly and ask how you can help them today. Be polite, professional, and concise in your responses.',
  inboundCallModel: process.env.INBOUND_CALL_MODEL ?? 'gpt-4',
  /**
   * E.164 number to cold-transfer when the voice agent escalates (stuck / handoff phrases).
   * Optional per-call override: call state metadata `supportTransferPhoneNumber`.
   */
  supportTransferPhoneNumber: process.env.SUPPORT_TRANSFER_PHONE_NUMBER ?? '',
}));
