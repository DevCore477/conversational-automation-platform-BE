import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import rateLimit, {
  type RateLimitExceededEventHandler,
  type RateLimitRequestHandler,
} from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import { Observable } from 'rxjs';

type RequestWithOptionalUser = Request & { user?: unknown };

function normalizeOriginUrl(value: string | undefined): string | undefined {
  if (value == null || value.trim() === '') return undefined;
  return value.trim().replace(/\/+$/, '');
}

function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim() !== '') {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0].split(',')[0].trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

@Injectable()
export class MakeCallRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(MakeCallRateLimitGuard.name);
  private readonly trustedOriginLimiter: RateLimitRequestHandler;
  private readonly untrustedAnonymousLimiter: RateLimitRequestHandler;
  private readonly trustedFrontend: string | undefined;
  private readonly trustedBackend: string | undefined;
  private readonly exemptAuthOnTrustedOrigin: boolean;

  constructor(private readonly configService: ConfigService) {
    const calls = this.configService.get<{
      frontendBaseUrl?: string;
      backendBaseUrl?: string;
      trustedOriginIpMax: number;
      trustedOriginIpWindowMs: number;
      trustedOriginIpLimitExemptWhenAuthenticated: boolean;
      untrustedAnonymousMax: number;
      untrustedAnonymousWindowMs: number;
    }>('calls');

    this.trustedFrontend = normalizeOriginUrl(calls?.frontendBaseUrl);
    this.trustedBackend = normalizeOriginUrl(calls?.backendBaseUrl);
    this.exemptAuthOnTrustedOrigin = calls?.trustedOriginIpLimitExemptWhenAuthenticated ?? true;

    const trustedMax = calls?.trustedOriginIpMax ?? 3;
    const trustedWindow = calls?.trustedOriginIpWindowMs ?? 24 * 60 * 60 * 1000;
    const anonMax = calls?.untrustedAnonymousMax ?? 3;
    const anonWindow = calls?.untrustedAnonymousWindowMs ?? 15 * 60 * 1000;

    const nestRateLimitHandler: RateLimitExceededEventHandler = (
      _request,
      _response,
      next,
      optionsUsed,
    ) => {
      const raw = optionsUsed.message;
      const message =
        typeof raw === 'string'
          ? raw
          : typeof raw === 'function'
            ? 'Too many requests, please try again later.'
            : String(raw ?? 'Too many requests, please try again later.');
      const statusCode = optionsUsed.statusCode ?? HttpStatus.TOO_MANY_REQUESTS;
      next(new HttpException(message, statusCode));
    };

    this.trustedOriginLimiter = rateLimit({
      windowMs: trustedWindow,
      max: trustedMax,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => `trusted-origin-make-call:${getClientIp(req)}`,
      message:
        'Too many outbound call requests from this network for the current period. Try again later or sign in.',
      handler: nestRateLimitHandler,
    });

    this.untrustedAnonymousLimiter = rateLimit({
      windowMs: anonWindow,
      max: anonMax,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => `untrusted-anon-make-call:${getClientIp(req)}`,
      message: 'Too many requests from this IP, please try again later.',
      handler: nestRateLimitHandler,
    });

    this.logger.log(
      `MakeCall rate limits: trusted origin anonymous = ${String(trustedMax)} / ${String(trustedWindow)}ms per IP; untrusted anonymous = ${String(anonMax)} / ${String(anonWindow)}ms per IP`,
    );
  }

  private isTrustedOrigin(req: Request): boolean {
    const raw = req.headers.origin;
    const origin = typeof raw === 'string' ? normalizeOriginUrl(raw) : undefined;
    if (!origin) return false;
    return origin === this.trustedFrontend || origin === this.trustedBackend;
  }

  private runLimiter(
    limiter: RateLimitRequestHandler,
    request: RequestWithOptionalUser,
    response: Response,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const done: NextFunction = (err?: unknown) => {
        if (err !== undefined && err !== null) {
          reject(
            err instanceof Error
              ? err
              : new HttpException(String(err), HttpStatus.TOO_MANY_REQUESTS),
          );
          return;
        }
        resolve(true);
      };

      limiter(request, response, done);
    });
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithOptionalUser>();
    const response = context.switchToHttp().getResponse<Response>();

    const trusted = this.isTrustedOrigin(request);
    const hasUser = request.user != null;

    if (trusted) {
      if (this.exemptAuthOnTrustedOrigin && hasUser) {
        return true;
      }
      return this.runLimiter(this.trustedOriginLimiter, request, response);
    }

    if (hasUser) {
      return true;
    }

    return this.runLimiter(this.untrustedAnonymousLimiter, request, response);
  }
}
