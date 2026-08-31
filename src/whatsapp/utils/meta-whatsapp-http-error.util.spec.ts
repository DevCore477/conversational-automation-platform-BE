import { HttpStatus } from '@nestjs/common';

import { MetaWhatsAppApiError } from '../../clients/whatsapp/meta-whatsapp.client';
import {
  isMetaWhatsAppAuthError,
  mapMetaWhatsAppErrorToHttpException,
} from './meta-whatsapp-http-error.util';

describe('meta-whatsapp-http-error.util', () => {
  it('detects Meta HTTP 401 as auth error', () => {
    const err = new MetaWhatsAppApiError('Invalid OAuth access token', 190, 'OAuthException', 401);
    expect(isMetaWhatsAppAuthError(err)).toBe(true);
  });

  it('maps Meta auth errors to 424 with source=meta (not Hexa 401)', () => {
    const err = new MetaWhatsAppApiError('Invalid OAuth access token', 190, 'OAuthException', 401);
    const http = mapMetaWhatsAppErrorToHttpException(err);
    expect(http.getStatus()).toBe(HttpStatus.FAILED_DEPENDENCY);
    expect(http.getResponse()).toMatchObject({
      error: 'META_WHATSAPP_AUTH_ERROR',
      source: 'meta',
      metaCode: 190,
      metaHttpStatus: 401,
    });
  });

  it('maps non-auth Meta errors to 400 with source=meta', () => {
    const err = new MetaWhatsAppApiError('Invalid parameter', 100, 'GraphMethodException', 400);
    const http = mapMetaWhatsAppErrorToHttpException(err);
    expect(http.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(http.getResponse()).toMatchObject({
      error: 'META_WHATSAPP_ERROR',
      source: 'meta',
      metaCode: 100,
    });
  });
});
