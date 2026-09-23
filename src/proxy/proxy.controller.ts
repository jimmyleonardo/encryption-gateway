import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EncryptionService,
  GatewayResponse,
} from '../encryption/encryption.service.js';
import { ProxyService } from './proxy.service.js';
import { GatewayRequestDto } from '../common/dto/gateway-request.dto.js';

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
    config: ConfigService,
  ) {
    const mode = config.get<string>('ENCRYPT_RESPONSE') || 'true';
    if (mode !== 'true' && mode !== 'false') {
      throw new Error('ENCRYPT_RESPONSE must be true or false');
    }
    this.encryptResponse = mode === 'true';
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
