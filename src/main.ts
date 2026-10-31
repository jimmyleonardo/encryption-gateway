import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

/** "true" / "false" / hop count ("1") / Express preset or subnet list. */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();

  // Behind a load balancer / reverse proxy every request arrives from the
  // proxy's IP, so the per-IP rate limit would be shared by ALL clients.
  // TRUST_PROXY makes Express read the real client IP from X-Forwarded-For.
  if (process.env.TRUST_PROXY) {
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

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(
    `🚀 Encryption gateway running on http://localhost:${port}`,
    'Bootstrap',
  );
}
void bootstrap();
