import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './common/rate-limit.guard.js';
import { AppController } from './app.controller.js';
import { ProxyModule } from './proxy/proxy.module.js';
import { EncryptionModule } from './encryption/encryption.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    EncryptionModule,
    ProxyModule,
  ],
  controllers: [AppController],
  // Rate limit per client IP. RSA decryption is CPU-heavy, so this
  // keeps a single client from saturating the gateway.
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
