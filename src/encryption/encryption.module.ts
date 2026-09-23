import { Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service.js';
import { PublicKeyController } from './public-key.controller.js';

@Module({
  controllers: [PublicKeyController],
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
