import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EncryptionModule } from '../encryption/encryption.module.js';
import { ProxyController } from './proxy.controller.js';
import { ProxyService } from './proxy.service.js';

@Module({
  imports: [HttpModule, EncryptionModule],
  controllers: [ProxyController],
  providers: [ProxyService],
})
export class ProxyModule {}
