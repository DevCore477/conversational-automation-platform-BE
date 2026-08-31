import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';

import { MetaWhatsAppApiError } from '../../clients/whatsapp/meta-whatsapp.client';

/** Meta Graph OAuth / token error codes (not Hexa user auth). */
export const META_WHATSAPP_AUTH_ERROR_CODES = new Set([190, 102, 463, 467, 200]);

export function isMetaWhatsAppAuthError(error: MetaWhatsAppApiError): boolean {
  if (error.httpStatus === 401 || error.httpStatus === 403) {
    return true;
  }
  if (error.code != null && META_WHATSAPP_AUTH_ERROR_CODES.has(error.code)) {
    return true;
  }
  if (error.type === 'OAuthException') {
    return true;
  }
  return /expired|invalid.*token|session.*invalid|oauth|not authorized|permission denied/i.test(
    error.message,
  );
}

function metaAuthUserMessage(error: MetaWhatsAppApiError): string {
  switch (error.code) {
    case 190:
      return 'Meta WhatsApp access token is invalid or expired. Ask your administrator to refresh the WhatsApp connection in Meta Business Suite.';
    case 102:
      return 'Meta WhatsApp API session is invalid. Ask your administrator to reconnect WhatsApp in Meta Business Suite.';
    case 10:
      return 'Meta WhatsApp permission denied — check app permissions and the access token scope.';
    case 200:
      return 'Meta WhatsApp API permissions error — ensure the access token has whatsapp_business_management and whatsapp_business_messaging.';
    default:
      if (error.httpStatus === 401) {
        return 'Meta WhatsApp API rejected the request (unauthorized). Your WhatsApp Business connection may need to be refreshed — this is not a Hexa login issue.';
      }
      return (
        error.message ||
        'Meta WhatsApp API authentication failed. Contact your administrator to refresh the WhatsApp connection.'
      );
  }
}

function metaGeneralUserMessage(error: MetaWhatsAppApiError): string {
  const code = error.code;
  const base = error.message || 'Failed to send WhatsApp message';

  switch (code) {
    case 100:
      return 'Meta WhatsApp: invalid parameter — check phone number and template name.';
    case 131030:
      return 'Meta WhatsApp: recipient phone number is not a valid WhatsApp user.';
    case 132000:
      return 'Meta WhatsApp: template parameter count does not match the template.';
    case 132001:
      return 'Meta WhatsApp: template does not exist or is not approved.';
    case 132015:
      return 'Meta WhatsApp: template is paused or disabled.';
    case 131047:
      return 'Meta WhatsApp: outside 24-hour window — use an approved template to message this user first.';
    case 133010:
      return 'Meta WhatsApp: phone number not registered or missing permission.';
    default:
      return base.startsWith('Meta WhatsApp') ? base : `Meta WhatsApp: ${base}`;
  }
}

/**
 * Maps Meta Graph API failures to HTTP responses the frontend can distinguish from Hexa auth (401).
 * Meta token/OAuth failures use 424 + source=meta, not 401 Unauthorized.
 */
export function mapMetaWhatsAppErrorToHttpException(error: MetaWhatsAppApiError): HttpException {
  if (isMetaWhatsAppAuthError(error)) {
    return new HttpException(
      {
        statusCode: HttpStatus.FAILED_DEPENDENCY,
        error: 'META_WHATSAPP_AUTH_ERROR',
        message: metaAuthUserMessage(error),
        source: 'meta',
        metaCode: error.code ?? null,
        metaType: error.type ?? null,
        metaHttpStatus: error.httpStatus ?? null,
      },
      HttpStatus.FAILED_DEPENDENCY,
    );
  }

  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'META_WHATSAPP_ERROR',
    message: metaGeneralUserMessage(error),
    source: 'meta',
    metaCode: error.code ?? null,
    metaType: error.type ?? null,
    metaHttpStatus: error.httpStatus ?? null,
  });
}

/** Re-throw Meta API errors as structured HTTP exceptions; pass through everything else. */
export function rethrowWhatsAppProviderError(error: unknown): never {
  if (error instanceof MetaWhatsAppApiError) {
    throw mapMetaWhatsAppErrorToHttpException(error);
  }
  throw error;
}
