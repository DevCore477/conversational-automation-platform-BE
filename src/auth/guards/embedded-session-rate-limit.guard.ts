// auth/guards/embedded-session-rate-limit.guard.ts
import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import rateLimit, {
  type RateLimitExceededEventHandler,
  type RateLimitRequestHandler,
} from 'express-rate-limit';

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

/**
 * POST /auth/embedded-session mints a real login session, so it gets the same
 * per-IP abuse limiting as /auth/login. Runs before auth so it also throttles
 * attempts with an invalid/guessed bridge secret, not just successful exchanges.
 */
@Injectable()
export class EmbeddedSessionRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(EmbeddedSessionRateLimitGuard.name);
  private readonly limiter: RateLimitRequestHandler;

  constructor(private readonly configService: ConfigService) {
    const max = this.configService.get<number>('auth.embeddedSessionRateLimitMax', 30);
    const windowMs = this.configService.get<number>(
      'auth.embeddedSessionRateLimitWindowMs',
      5 * 60 * 1000,
    );

    const handler: RateLimitExceededEventHandler = (_request, _response, next, optionsUsed) => {
      next(
        new HttpException(
          'Too many embedded-session requests from this IP, please try again later.',
          optionsUsed.statusCode,
        ),
      );
    };

    this.limiter = rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => `embedded-session:${getClientIp(req)}`,
      message: 'Too many embedded-session requests from this IP, please try again later.',
      handler,
    });

    this.logger.log(`embedded-session rate limit: ${String(max)} / ${String(windowMs)}ms per IP`);
  }

  canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    return new Promise((resolve, reject) => {
      const done: NextFunction = (err?: unknown) => {
        if (err !== undefined && err !== null) {
          reject(
            err instanceof Error
              ? err
              : new HttpException('Rate limit error', HttpStatus.TOO_MANY_REQUESTS),
          );
          return;
        }
        resolve(true);
      };

      this.limiter(request, response, done);
    });
  }
}
