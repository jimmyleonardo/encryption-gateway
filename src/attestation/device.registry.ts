import { Inject, Injectable } from '@nestjs/common';
import { KeyObject, createPublicKey } from 'node:crypto';
import type { KvStore } from './kv.store.js';
import { KV_STORE } from './kv.store.js';

export interface EnrolledDevice {
  publicKey: KeyObject;
  securityLevel: number;
  enrolledAt: Date;
}

/** Wire form: a KeyObject cannot be serialised, so the SPKI DER is stored instead. */
interface StoredDevice {
  spki: string;
  securityLevel: number;
  enrolledAt: string;
}

@Injectable()
export class DeviceRegistry {
  constructor(@Inject(KV_STORE) private readonly kv: KvStore) {}

  async get(deviceId: string): Promise<EnrolledDevice | undefined> {
    const raw = await this.kv.get(this.key(deviceId));
    if (!raw) return undefined;
    try {
      const stored = JSON.parse(raw) as StoredDevice;
      return {
        publicKey: createPublicKey({
          key: Buffer.from(stored.spki, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        securityLevel: stored.securityLevel,
        enrolledAt: new Date(stored.enrolledAt),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Enrols a device only when the id is free. Returns false when it is already
   * taken, so that an attacker cannot re-bind someone else's device id to a key
   * of their own; removing the old enrolment is a deliberate admin action.
   */
  async enrol(deviceId: string, device: EnrolledDevice): Promise<boolean> {
    return this.kv.setIfAbsent(
      this.key(deviceId),
      JSON.stringify(this.encode(device)),
      undefined,
    );
  }

  async has(deviceId: string): Promise<boolean> {
    return (await this.kv.get(this.key(deviceId))) !== null;
  }

  async delete(deviceId: string): Promise<boolean> {
    return this.kv.delete(this.key(deviceId));
  }

  private encode(device: EnrolledDevice): StoredDevice {
    return {
      spki: device.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64'),
      securityLevel: device.securityLevel,
      enrolledAt: device.enrolledAt.toISOString(),
    };
  }

  private key(deviceId: string): string {
    return `attestation:device:${deviceId}`;
  }
}
