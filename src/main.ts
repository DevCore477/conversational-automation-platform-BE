import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Request } from 'express';

import { AppModule } from './app.module';
import { setupSwagger } from './configs/swagger.config';

const DEFAULT_FRONTEND_ORIGINS = new Set([
  'https://gethexa.ai', // Production frontend
  'https://api.gethexa.ai/', // API endpoint (if needed)
  'https://www.gethexa.ai', // WWW variant
  'http://localhost:3000', // Local development (optional)
  'http://localhost:3001', // Local development (optional)
]);

/**
 * /mozo/* is called directly from a browser inside Mozo's iframe, which needs its own,
 * separately-configured origin allowlist (MOZO_ALLOWED_ORIGINS) — never the production
 * frontend list, and vice versa. This has to be a single `enableCors` delegate rather than
 * a second CORS middleware scoped to /mozo: the `cors` package always terminates OPTIONS
 * preflight requests once app.enableCors() is registered globally (regardless of whether the
 * origin matched), so a second, route-scoped CORS middleware would never even be reached for
 * preflight requests to /mozo/*.
 */
interface MozoCorsOptions {
  origin: string | false;
  methods: string;
  credentials: boolean;
  allowedHeaders: string;
}

/** Untyped against the `cors`/`@nestjs/common` packages on purpose — their two `CorsOptions`
 * declarations aren't structurally compatible (one requires the callback's options param
 * non-optional, the other doesn't), so a precisely-typed delegate satisfies one and not the
 * other. `enableCors` only cares that this is callable as `(req, cb) => void`. */
function buildCorsOptionsDelegate(mozoAllowedOrigins: string[]) {
  const mozoOrigins = new Set(mozoAllowedOrigins);

  return (expressReq: unknown, callback: (err: null, options: MozoCorsOptions) => void) => {
    const req = expressReq as Request;
    const origin = req.headers.origin;
    const isMozoRoute = req.path.startsWith('/mozo/');
    const allowedOrigins = isMozoRoute ? mozoOrigins : DEFAULT_FRONTEND_ORIGINS;

    callback(null, {
      origin: origin != null && allowedOrigins.has(origin) ? origin : false,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      // The Mozo widget authenticates via body/query params, not cookies — no need for credentials.
      credentials: !isMozoRoute,
      allowedHeaders: isMozoRoute
        ? 'Content-Type,Authorization'
        : 'Content-Type, Authorization, Accept',
    });
  };
}

const processLogger = new Logger('Process');

/**
 * A single call's promise chain (TTS/STT/LLM WebSocket lifecycle) rejecting without a handler
 * used to take down the ENTIRE process — killing every other concurrent call, not just the
 * failing one. Node's default behavior for an unhandled rejection is to terminate the process;
 * this handler logs it instead so unrelated in-progress calls survive. This is a safety net, not
 * a substitute for fixing the underlying missing `.catch()` — every occurrence here should be
 * traced back to its call site and given a proper handler.
 */
function registerProcessCrashGuards(): void {
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    processLogger.error(
      `Unhandled promise rejection (process kept alive): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
    void promise.catch(() => {
      /* already logged above */
    });
  });

  // Per Node's own guidance, the process is in an undefined state after a synchronous uncaught
  // exception — resuming normal operation risks corrupted in-memory state (e.g. a stuck call
  // session lock). Log with full context so the crash is diagnosable, then exit so a process
  // supervisor (PM2/systemd/k8s) restarts cleanly, rather than crashing silently with no trace.
  process.on('uncaughtException', (error: Error) => {
    processLogger.error(`Uncaught exception (process exiting): ${error.stack ?? error.message}`);
    process.exit(1);
  });
}

async function bootstrap() {
  registerProcessCrashGuards();

  // rawBody required for Meta WhatsApp X-Hub-Signature-256 (must hash exact POST bytes)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // So req.ip / rate limits respect X-Forwarded-For behind a reverse proxy or load balancer.
  const trustProxy = process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy === 'false' || trustProxy === '0' ? false : (trustProxy ?? 1));

  setupSwagger(app);

  const configService = app.get(ConfigService);
  const mozoAllowedOrigins = configService.get<string[]>('mozo.allowedOrigins', []);
  // buildCorsOptionsDelegate(mozoAllowedOrigins)
  app.enableCors();

  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
