import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { KeyObject } from 'node:crypto';
import {
  ATTESTATION_POLICY,
  AttestationRejectedError,
  AttestationService,
} from './attestation.service.js';
import type { AttestationPolicy } from './attestation.service.js';
import { ChallengeStore } from './challenge.store.js';
import { DeviceRegistry } from './device.registry.js';
import { ChallengeRequestDto } from './dto/challenge.dto.js';
import { EnrollDeviceDto } from './dto/enroll.dto.js';
import { VerifyDeviceDto } from './dto/verify.dto.js';

@Controller('v1')
export class AttestationController {
  constructor(
    private readonly attestation: AttestationService,
    private readonly challenges: ChallengeStore,
    private readonly devices: DeviceRegistry,
    @Inject(ATTESTATION_POLICY) private readonly policy: AttestationPolicy,
  ) {}

  /** Without an app identity nothing can be verified; say so rather than rejecting every chain. */
  private assertConfigured(): void {
    if (!this.policy.configured) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        code: 'ATTESTATION_NOT_CONFIGURED',
        reason:
          'set ATTESTATION_PACKAGE_NAME and ATTESTATION_SIGNING_CERT_SHA256 to enable attestation',
      });
    }
  }

  /**
   * Request a fresh attestation challenge.
   * `purpose` defaults to "enroll"; use the specific purpose for signed routes (e.g. "transfer", "auth").
   */
  @Post('challenges')
  @HttpCode(200)
  async challenge(@Body() body: ChallengeRequestDto = {}) {
    const { challengeId, nonce } = await this.challenges.issue(
      body?.purpose ?? 'enroll',
    );
    return { challengeId, nonce: nonce.toString('base64') };
  }

  /**
   * Enrolls a device by verifying its hardware Key Attestation certificate chain.
   */
  @Post('devices/enroll')
  @HttpCode(200)
  async enroll(@Body() body: EnrollDeviceDto) {
    this.assertConfigured();
    const nonce = await this.challenges.consume(body.challengeId, 'enroll');
    if (!nonce) {
      throw new UnauthorizedException({
        status: 'rejected',
        reason: 'unknown or expired challenge',
      });
    }

    let publicKey: KeyObject;
    let securityLevel: number;
    try {
      // Verify the hardware attestation chain.
      ({ publicKey, securityLevel } = this.attestation.verify(
        body.certificateChain.map((cert) => Buffer.from(cert, 'base64')),
        nonce,
      ));
    } catch (e) {
      if (e instanceof AttestationRejectedError) {
        throw new ForbiddenException({
          status: 'rejected',
          code: e.code,
          reason: e.message,
        });
      }
      throw e;
    }

    // An enrolled device id is never silently re-bound to a different key:
    // that would let anyone who guesses an id take over the device. Rotating a
    // key requires deleting the enrolment out of band first.
    const enrolled = await this.devices.enrol(body.deviceId, {
      publicKey,
      securityLevel,
      enrolledAt: new Date(),
    });
    if (!enrolled) {
      throw new ConflictException({
        status: 'rejected',
        code: 'DEVICE_ALREADY_ENROLLED',
        reason:
          'device already enrolled; delete the enrolment before re-enrolling',
      });
    }

    return { status: 'enrolled', securityLevel };
  }

  /**
   * Verifies a device signature against its enrolled public key.
   * The challenge must have been issued with `purpose: "verify"`.
   */
  @Post('devices/verify')
  @HttpCode(200)
  async verify(@Body() body: VerifyDeviceDto) {
    this.assertConfigured();
    const nonce = await this.challenges.consume(body.challengeId, 'verify');
    const device = await this.devices.get(body.deviceId);
    if (!nonce || !device) {
      throw new UnauthorizedException({
        status: 'rejected',
        reason: 'unknown challenge or device',
      });
    }
    if (
      !this.attestation.verifySignature(
        device.publicKey,
        nonce,
        Buffer.from(body.signature, 'base64'),
      )
    ) {
      throw new UnauthorizedException({
        status: 'rejected',
        reason: 'invalid signature',
      });
    }
    return { status: 'verified' };
  }
}
