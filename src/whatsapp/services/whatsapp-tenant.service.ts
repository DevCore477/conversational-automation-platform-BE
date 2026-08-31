import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { UserRole } from '../../common/enums';
import type { ValidatedUser } from '../../auth/services/token-validation.service';

@Injectable()
export class WhatsAppTenantService {
  /** Resolve companyId from authenticated user — never trust body for normal users. */
  resolveCompanyId(user: ValidatedUser | undefined, bodyCompanyId?: string): string {
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    if (user.role === UserRole.ADMIN && bodyCompanyId) {
      return bodyCompanyId;
    }

    if (!user.companyId) {
      throw new ForbiddenException('User is not associated with a company');
    }

    if (bodyCompanyId && bodyCompanyId !== user.companyId) {
      throw new ForbiddenException('Cannot access another company’s resources');
    }

    return user.companyId;
  }

  assertCampaignOwnership(campaignCompanyId: string | null, userCompanyId: string): void {
    if (!campaignCompanyId || campaignCompanyId !== userCompanyId) {
      throw new ForbiddenException('Campaign not found for your company');
    }
  }

  isSuperAdmin(user: ValidatedUser | undefined): boolean {
    return user?.role === UserRole.ADMIN;
  }

  /**
   * Resolve company scope for campaign APIs.
   * Super Admin may pass `queryCompanyId` or omit it to resolve from the campaign row.
   */
  resolveCampaignCompanyScope(
    user: ValidatedUser | undefined,
    queryCompanyId?: string,
  ): string | undefined {
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    if (this.isSuperAdmin(user)) {
      return queryCompanyId?.trim() || undefined;
    }

    return this.resolveCompanyId(user, queryCompanyId);
  }
}
