import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EncryptionService,
  GatewayResponse,
} from '../encryption/encryption.service.js';
import { ProxyService } from './proxy.service.js';
import { GatewayRequestDto } from '../common/dto/gateway-request.dto.js';
import { strictBoolean } from '../common/config.js';
import { ReplayProtectionService } from '../common/replay-protection.service.js';

export interface PlainGatewayResponse {
  Encrypted: false;
  StatusCode: number;
  Headers: Record<string, string | string[]>;
  Data: unknown;
}

@Controller('api')
export class ProxyController {
  private readonly encryptResponse: boolean;

  constructor(
    private readonly encryptionService: EncryptionService,
    private readonly proxyService: ProxyService,
    private readonly replayProtection: ReplayProtectionService,
    config: ConfigService,
  ) {
    this.encryptResponse = strictBoolean(config, 'ENCRYPT_RESPONSE', true);
  }

  /**
   * Main Gateway endpoint (supports both /api/gateway and /api/v2/gateway):
   *   - RSA-OAEP-SHA256 for the AES key
   *   - Requests always use AES-256-GCM.
   *   - Server configuration determines response encryption; clients cannot override it.
   */
  @Post(['gateway', 'v2/gateway'])
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async handleGateway(
    @Body() dto: GatewayRequestDto,
  ): Promise<GatewayResponse | PlainGatewayResponse> {
    const { payload, aesKey } = this.encryptionService.decrypt(dto);
    this.replayProtection.assertFresh(payload);

    const upstream = await this.proxyService.forward(payload);

    const result = {
      StatusCode: upstream.status,
      Headers: upstream.headers,
      Data: upstream.data,
    };
    return this.encryptResponse
      ? this.encryptionService.encryptResponse(result, aesKey)
      : { Encrypted: false, ...result };
  }
}
