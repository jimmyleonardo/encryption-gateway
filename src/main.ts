import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';

/** "true" / "false" / hop count ("1") / Express preset or subnet list. */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

/**
 * Small set of API security headers. Kept local instead of pulling in helmet,
 * whose packaging breaks the Vercel NestJS build.
 */
function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (req.secure) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
  next();
}

/** Reject a PORT that body-parser or the OS would silently reinterpret. */
function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 3000;
  const port = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      `PORT must be an integer between 1 and 65535 (got ${JSON.stringify(value)})`,
    );
  }
  return port;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  // Behind a load balancer / reverse proxy every request arrives from the
  // proxy's IP, so the per-IP rate limit would be shared by ALL clients.
  // TRUST_PROXY makes Express read the real client IP from X-Forwarded-For.
  if (process.env.TRUST_PROXY) {
    if (
      process.env.TRUST_PROXY === 'true' &&
      process.env.NODE_ENV === 'production'
    ) {
      Logger.warn(
        'TRUST_PROXY=true trusts every forwarded address. Set the exact hop count or proxy subnet instead.',
        'Bootstrap',
      );
    }
    app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
  }

  // v2 has no chunk limit, so cap the raw JSON body instead.
  app.useBodyParser('json', { limit: process.env.MAX_BODY_SIZE || '1mb' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Browsers need CORS to call the gateway directly. Comma-separated
  // origins, e.g. "https://app.example.com". Unset = CORS disabled.
  const corsOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins?.length) {
    app.enableCors({ origin: corsOrigins, methods: ['POST', 'GET'] });
  }

  const port = parsePort(process.env.PORT);
  await app.listen(port);
  Logger.log(
    `🚀 Encryption gateway running on http://localhost:${port}`,
    'Bootstrap',
  );
}
void bootstrap();
