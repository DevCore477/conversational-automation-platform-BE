import type { ValidatedUser } from '../../auth/services/token-validation.service';
import { UserRole } from '../../common/enums';

export interface TrustedCallerAttribution {
  source: 'authenticated_user' | 'request_body';
  userId?: string;
  email?: string;
  displayName?: string;
}

export function normalizeTrustedOriginUrl(value: string | undefined): string | undefined {
  if (value == null || value.trim() === '') return undefined;
  return value.trim().replace(/\/+$/, '');
}

export function resolveTrustedCallerAttribution(
  req: { headers: { origin?: string }; user?: ValidatedUser },
  dto: { callerName?: string; callerEmail?: string },
  config: { frontendBaseUrl?: string; backendBaseUrl?: string },
): TrustedCallerAttribution | undefined {
  const originNorm = normalizeTrustedOriginUrl(
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
  );
  const frontend = normalizeTrustedOriginUrl(config.frontendBaseUrl);
  const backend = normalizeTrustedOriginUrl(config.backendBaseUrl);
  const isTrusted = originNorm != null && (originNorm === frontend || originNorm === backend);
  if (!isTrusted) return undefined;

  const u = req.user;
  if (u?.companyId) return undefined;

  if (u && !u.companyId) {
    if (u.role === UserRole.ADMIN) return undefined;
    const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return {
      source: 'authenticated_user',
      userId: u.id,
      email: u.email,
      ...(displayName ? { displayName } : {}),
    };
  }

  const name = dto.callerName?.trim();
  const email = dto.callerEmail?.trim();
  if (name || email) {
    return {
      source: 'request_body',
      ...(name ? { displayName: name } : {}),
      ...(email ? { email } : {}),
    };
  }

  return undefined;
}
