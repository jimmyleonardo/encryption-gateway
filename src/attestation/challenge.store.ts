import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { KvStore } from './kv.store.js';
import { KV_STORE } from './kv.store.js';

/** Challenges are short-lived: long enough for a round trip, short enough to limit replay windows. */
export const CHALLENGE_TTL_MS = 60_000;

interface StoredChallenge {
  nonce: string;
  purpose: string;
}

@Injectable()
export class ChallengeStore {
  constructor(@Inject(KV_STORE) private readonly kv: KvStore) {}

  /**
   * Issues a fresh, single-use cryptographic challenge.
   */
  async issue(purpose = 'enroll'): Promise<{
    challengeId: string;
    nonce: Buffer;
  }> {
    const challengeId = randomUUID();
    const nonce = randomBytes(32);
    const stored: StoredChallenge = {
      nonce: nonce.toString('base64'),
      purpose,
    };
    await this.kv.set(
      this.key(challengeId),
      JSON.stringify(stored),
      CHALLENGE_TTL_MS,
    );
    return { challengeId, nonce };
  }

  /**
   * Consumes and invalidates a single-use challenge.
   * Returns the nonce if valid, or null if expired, not found, or purpose mismatch.
   */
  async consume(
    challengeId: string,
    expectedPurpose = 'enroll',
  ): Promise<Buffer | null> {
    const raw = await this.kv.getDelete(this.key(challengeId));
    if (!raw) return null;
    let stored: StoredChallenge;
    try {
      stored = JSON.parse(raw) as StoredChallenge;
    } catch {
      return null;
    }
    // Constant-time so that a caller cannot probe purposes by timing.
    if (!equals(stored.purpose, expectedPurpose)) return null;
    return Buffer.from(stored.nonce, 'base64');
  }

  private key(challengeId: string): string {
    return `attestation:challenge:${challengeId}`;
  }
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
