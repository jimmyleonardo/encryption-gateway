import { Controller, Get } from '@nestjs/common';
import { SkipRateLimit } from '../common/rate-limit.guard.js';
import { EncryptionService } from './encryption.service.js';
import type { PublicKeyInfo } from './encryption.service.js';

/**
 * Publishes the server public key so client teams can fetch it in the
 * format their platform needs. Clients should EMBED the key in the app
 * (and may compare `sha256Fingerprint`), not fetch it at runtime —
 * fetching over an untrusted network lets an attacker swap the key.
 */
@Controller('public-key')
export class PublicKeyController {
  constructor(private readonly encryptionService: EncryptionService) {}

  @Get()
  @SkipRateLimit()
  get(): PublicKeyInfo {
    return this.encryptionService.getPublicKeyInfo();
  }
}
