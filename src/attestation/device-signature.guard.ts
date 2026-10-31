import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  applyDecorators,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AttestationService } from './attestation.service.js';
import { ChallengeStore } from './challenge.store.js';
import { DeviceRegistry } from './device.registry.js';

/**
 * `required`: requests without a valid device signature are rejected (only attested devices get through).
 * `report`: every request passes; `request.device.verified` informs handler whether to demand step-up auth.
 */
export type DevicePolicy = 'report' | 'required';
export const DEVICE_POLICY = Symbol('DEVICE_POLICY');

/** Attached to the request by the guard. */
export interface DeviceContext {
  verified: boolean;
  deviceId?: string;
  reason?: string;
}

const PURPOSE = 'attestation:device-signature-purpose';

/**
 * Protects a route with a device signature. The client first calls `POST /v1/challenges {purpose}`,
 * signs the nonce with `the device key`, and sends these headers:
 * `X-Device-Id`, `X-Device-Challenge-Id`, `X-Device-Signature` (Base64).
 */
export const RequireDeviceSignature = (purpose: string) =>
  applyDecorators(
    SetMetadata(PURPOSE, purpose),
    UseGuards(DeviceSignatureGuard),
  );

@Injectable()
export class DeviceSignatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly attestation: AttestationService,
    private readonly challenges: ChallengeStore,
    private readonly devices: DeviceRegistry,
    @Inject(DEVICE_POLICY) private readonly policy: DevicePolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      device?: DeviceContext;
    }>();
    const purpose = this.reflector.get<string>(PURPOSE, context.getHandler());
    const device = await this.check(request.headers, purpose);
    if (!device.verified && this.policy === 'required') {
      throw new UnauthorizedException({
        status: 'rejected',
        code: device.reason,
      });
    }
    request.device = device;
    return true;
  }

  private async check(
    headers: Record<string, string | undefined>,
    purpose: string,
  ): Promise<DeviceContext> {
    const deviceId = headers['x-device-id'];
    const challengeId = headers['x-device-challenge-id'];
    const signature = headers['x-device-signature'];
    if (!deviceId || !challengeId || !signature) {
      return { verified: false, reason: 'DEVICE_SIGNATURE_MISSING' };
    }

    const nonce = await this.challenges.consume(challengeId, purpose);
    if (!nonce) {
      return { verified: false, deviceId, reason: 'DEVICE_CHALLENGE_INVALID' };
    }
    const enrolled = await this.devices.get(deviceId);
    if (!enrolled) {
      return { verified: false, deviceId, reason: 'DEVICE_NOT_ENROLLED' };
    }
    if (
      !this.attestation.verifySignature(
        enrolled.publicKey,
        nonce,
        Buffer.from(signature, 'base64'),
      )
    ) {
      return { verified: false, deviceId, reason: 'DEVICE_SIGNATURE_INVALID' };
    }
    return { verified: true, deviceId };
  }
}
