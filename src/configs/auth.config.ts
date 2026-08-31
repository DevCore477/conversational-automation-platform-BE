import { registerAs } from '@nestjs/config';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default registerAs('auth', () => ({
  jwtSecret: process.env.JWT_SECRET ?? '',
  /** @deprecated Use jwtAccessExpiresIn; kept for env parity. */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  jwtAccessExpiresIn:
    (process.env.JWT_ACCESS_EXPIRES_IN ?? '').trim() ||
    (process.env.JWT_EXPIRES_IN ?? '').trim() ||
    '7d',
  refreshTokenExpiresDays: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS ?? 30) || 30,
  resetTokenExpiresHours: Number(process.env.RESET_TOKEN_EXPIRES_HOURS ?? 2) || 2,
  inviteExpiresHours: Number(process.env.INVITE_EXPIRES_HOURS ?? 72) || 72,
  passwordSaltRounds: Number(process.env.PASSWORD_SALT_ROUNDS ?? 12) || 12,
  frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? process.env.APP_BASE_URL,
  /**
   * Access-token lifetime for POST /auth/session-from-api-key (embedded/iframe
   * sessions minted from a company API key, e.g. the Mozo widget). Short by
   * design — the caller is expected to re-exchange the API key rather than
   * hold a long-lived session, since no refresh token is issued for these.
   */
  embeddedSessionAccessExpiresIn:
    (process.env.EMBEDDED_SESSION_ACCESS_EXPIRES_IN ?? '').trim() || '20m',
  /** Per-IP cap on POST /auth/session-from-api-key — it mints real login sessions, so it gets login-grade abuse limits. */
  embeddedSessionRateLimitMax: parsePositiveInt(process.env.EMBEDDED_SESSION_RATE_LIMIT_MAX, 30),
  embeddedSessionRateLimitWindowMs: parsePositiveInt(
    process.env.EMBEDDED_SESSION_RATE_LIMIT_WINDOW_MS,
    5 * 60 * 1000,
  ),
}));
