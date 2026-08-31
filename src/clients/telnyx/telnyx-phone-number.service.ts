import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Resolves which Telnyx DID to dial/transfer *from*, based on which company the call belongs to.
 *
 * Today this is a single override (Company A → Netherlands number, everyone else → the generic
 * default), but it's written as a map lookup so adding another company → number pair later is a
 * one-line change here instead of new branching at every call site.
 */
@Injectable()
export class TelnyxPhoneNumberService {
  private readonly logger = new Logger(TelnyxPhoneNumberService.name);

  /** company id -> Telnyx DID overrides, built once from env at startup. */
  private readonly companyOverrides: ReadonlyMap<string, string>;

  constructor(private readonly configService: ConfigService) {
    this.companyOverrides = this.buildCompanyOverrides();
  }

  private buildCompanyOverrides(): ReadonlyMap<string, string> {
    const overrides = new Map<string, string>();

    const nlCompanyId = this.configService.get<string>('app.telnyxNlCompanyId')?.trim() ?? '';
    const nlNumber = this.configService.get<string>('app.telnyxPhoneNumberNl')?.trim() ?? '';

    if (nlCompanyId !== '' && nlNumber !== '') {
      overrides.set(nlCompanyId, nlNumber);
    } else if (nlCompanyId !== '' && nlNumber === '') {
      this.logger.warn(
        'TELNYX_NL_COMPANY_ID is set but TELNYX_PHONE_NUMBER_NL is not — that company will fall back to the default Telnyx number.',
      );
    }

    return overrides;
  }

  /**
   * Returns the Telnyx DID to use as the outbound `from` / transfer caller ID for `companyId`.
   * Falls back to `TELNYX_PHONE_NUMBER` for unknown/missing companies. Returns `''` if even the
   * default isn't configured — callers already handle that as "Telnyx not configured".
   */
  resolveFromNumber(companyId?: string | null): string {
    const defaultNumber = this.configService.get<string>('app.telnyxPhoneNumber')?.trim() ?? '';

    if (companyId == null || companyId === '') {
      return defaultNumber;
    }

    return this.companyOverrides.get(companyId) ?? defaultNumber;
  }
}
