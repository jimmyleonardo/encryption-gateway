import { Test, TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import {
  KeyObject,
  generateKeyPairSync,
  sign,
  verify as cryptoVerify,
} from 'node:crypto';
import { AttestationController } from './attestation.controller.js';
import {
  AttestationRejectedError,
  AttestationService,
} from './attestation.service.js';
import { ChallengeStore } from './challenge.store.js';
import { DeviceRegistry } from './device.registry.js';
import { ATTESTATION_POLICY } from './attestation.service.js';
import { KV_STORE, MemoryKvStore } from './kv.store.js';
import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

const chainOf = (...parts: string[]) =>
  parts.map((p) => Buffer.from(p).toString('base64'));

describe('AttestationController', () => {
  let controller: AttestationController;
  let devices: DeviceRegistry;
  const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  // Stands in for the real chain verification, which attestation.service.spec covers.
  const mockAttestationService = {
    verify: jest.fn((chain: Buffer[]) => {
      if (chain[0].toString() === 'bad-apk') {
        throw new AttestationRejectedError(
          'SIGNER_NOT_ALLOWED',
          'signature mismatch',
        );
      }
      return { publicKey: ecKey.publicKey, securityLevel: 1 };
    }),
    verifySignature: (key: KeyObject, data: Buffer, signature: Buffer) => {
      try {
        return cryptoVerify('sha256', data, key, signature);
      } catch {
        return false;
      }
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AttestationController],
      providers: [
        { provide: AttestationService, useValue: mockAttestationService },
        { provide: KV_STORE, useValue: new MemoryKvStore() },
        { provide: ATTESTATION_POLICY, useValue: { configured: true } },
        ChallengeStore,
        DeviceRegistry,
      ],
    }).compile();

    controller = module.get(AttestationController);
    devices = module.get(DeviceRegistry);
  });

  describe('challenge()', () => {
    it('issues a challenge with challengeId and base64 nonce', async () => {
      const res = await controller.challenge({ purpose: 'enroll' });
      expect(res.challengeId).toBeDefined();
      expect(Buffer.from(res.nonce, 'base64').length).toBe(32);
    });

    it('issues a distinct nonce each time', async () => {
      const a = await controller.challenge({ purpose: 'enroll' });
      const b = await controller.challenge({ purpose: 'enroll' });
      expect(a.nonce).not.toBe(b.nonce);
      expect(a.challengeId).not.toBe(b.challengeId);
    });
  });

  describe('enroll()', () => {
    it('successfully enrolls a valid hardware attestation chain', async () => {
      const { challengeId } = await controller.challenge({ purpose: 'enroll' });
      const res = await controller.enroll({
        challengeId,
        deviceId: 'device-123',
        certificateChain: chainOf('cert1', 'cert2'),
      });

      expect(res.status).toBe('enrolled');
      expect(res.securityLevel).toBe(1);
      expect(await devices.has('device-123')).toBe(true);
    });

    it('rejects expired or invalid challenge', async () => {
      await expect(
        controller.enroll({
          challengeId: 'non-existent',
          deviceId: 'device-123',
          certificateChain: chainOf('cert1', 'cert2'),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a challenge issued for another purpose', async () => {
      const { challengeId } = await controller.challenge({
        purpose: 'transfer',
      });
      await expect(
        controller.enroll({
          challengeId,
          deviceId: 'device-purpose',
          certificateChain: chainOf('cert1', 'cert2'),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('consumes the challenge, so it cannot be replayed', async () => {
      const { challengeId } = await controller.challenge({ purpose: 'enroll' });
      await controller.enroll({
        challengeId,
        deviceId: 'device-replay',
        certificateChain: chainOf('cert1', 'cert2'),
      });
      await expect(
        controller.enroll({
          challengeId,
          deviceId: 'device-replay-2',
          certificateChain: chainOf('cert1', 'cert2'),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects modified APK with ForbiddenException', async () => {
      const { challengeId } = await controller.challenge({ purpose: 'enroll' });
      await expect(
        controller.enroll({
          challengeId,
          deviceId: 'device-mod',
          certificateChain: chainOf('bad-apk', 'cert2'),
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('never re-binds an enrolled device id to another key', async () => {
      const first = await controller.challenge({ purpose: 'enroll' });
      await controller.enroll({
        challengeId: first.challengeId,
        deviceId: 'device-duplicate',
        certificateChain: chainOf('cert1', 'cert2'),
      });

      const second = await controller.challenge({ purpose: 'enroll' });
      await expect(
        controller.enroll({
          challengeId: second.challengeId,
          deviceId: 'device-duplicate',
          certificateChain: chainOf('cert1', 'cert2'),
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('allows re-enrolment after the enrolment is deleted', async () => {
      const first = await controller.challenge({ purpose: 'enroll' });
      await controller.enroll({
        challengeId: first.challengeId,
        deviceId: 'device-rotate',
        certificateChain: chainOf('cert1', 'cert2'),
      });
      expect(await devices.delete('device-rotate')).toBe(true);

      const second = await controller.challenge({ purpose: 'enroll' });
      const res = await controller.enroll({
        challengeId: second.challengeId,
        deviceId: 'device-rotate',
        certificateChain: chainOf('cert1', 'cert2'),
      });
      expect(res.status).toBe('enrolled');
    });
  });

  describe('verify()', () => {
    const enrol = async (deviceId: string) => {
      const { challengeId } = await controller.challenge({ purpose: 'enroll' });
      await controller.enroll({
        challengeId,
        deviceId,
        certificateChain: chainOf('cert1', 'cert2'),
      });
    };

    it('verifies a valid signature from an enrolled device', async () => {
      await enrol('device-verify-1');
      const challenge = await controller.challenge({ purpose: 'verify' });
      const signature = sign(
        'sha256',
        Buffer.from(challenge.nonce, 'base64'),
        ecKey.privateKey,
      );

      const res = await controller.verify({
        challengeId: challenge.challengeId,
        deviceId: 'device-verify-1',
        signature: signature.toString('base64'),
      });
      expect(res.status).toBe('verified');
    });

    it('rejects a signature made with a different key', async () => {
      await enrol('device-verify-2');
      const challenge = await controller.challenge({ purpose: 'verify' });
      const signature = sign(
        'sha256',
        Buffer.from(challenge.nonce, 'base64'),
        otherKey.privateKey,
      );

      await expect(
        controller.verify({
          challengeId: challenge.challengeId,
          deviceId: 'device-verify-2',
          signature: signature.toString('base64'),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unenrolled device', async () => {
      const challenge = await controller.challenge({ purpose: 'verify' });
      const signature = sign(
        'sha256',
        Buffer.from(challenge.nonce, 'base64'),
        ecKey.privateKey,
      );
      await expect(
        controller.verify({
          challengeId: challenge.challengeId,
          deviceId: 'never-enrolled',
          signature: signature.toString('base64'),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a challenge issued for enrolment', async () => {
      await enrol('device-verify-3');
      const challenge = await controller.challenge({ purpose: 'enroll' });
      const signature = sign(
        'sha256',
        Buffer.from(challenge.nonce, 'base64'),
        ecKey.privateKey,
      );
      await expect(
        controller.verify({
          challengeId: challenge.challengeId,
          deviceId: 'device-verify-3',
          signature: signature.toString('base64'),
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
