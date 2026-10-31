import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { positiveInteger, strictBoolean } from './config.js';
import type { DecryptedPayload } from './payload.js';

const NONCE_PATTERN = /^[\x21-\x7e]{16,128}$/;
const SECONDS_THRESHOLD = 1e12;

/**
 * Optional replay protection for non-idempotent requests.
 *
 * Disabled by default. When REQUIRE_REQUEST_NONCE=true, the encrypted payload
 * must carry a fresh `Nonce` and a `Timestamp`, and each nonce can be used
 * once inside the allowed clock window.
 *
 * The cache is per process, like the rate limiter. A multi-instance deployment
 * needs a shared store to make this a hard guarantee; the backend should still
 * enforce idempotency for money-moving operations.
 */
@Injectable()
export class ReplayProtectionService {
  private readonly required: boolean;
  private readonly maxSkewMs: number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();

  constructor(config: ConfigService) {
    this.required = strictBoolean(config, 'REQUIRE_REQUEST_NONCE', false);
    this.maxSkewMs = positiveInteger(config, 'REQUEST_MAX_SKEW_MS', 60_000);
    this.maxEntries = positiveInteger(
      config,
      'REPLAY_CACHE_MAX_ENTRIES',
      10_000,
    );
  }

  assertFresh(payload: DecryptedPayload, now = Date.now()): void {
    if (!this.required) return;

    const nonce = payload.Nonce;
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
      throw this.reject(
        'REQUEST_NONCE_INVALID',
        'Nonce must be 16-128 printable ASCII characters',
      );
    }

    const timestamp = parseTimestamp(payload.Timestamp);
    if (timestamp === null) {
      throw this.reject(
        'REQUEST_TIMESTAMP_INVALID',
        'Timestamp must be an ISO-8601 string or epoch seconds/milliseconds',
      );
    }
    if (Math.abs(now - timestamp) > this.maxSkewMs) {
      throw this.reject(
        'REQUEST_EXPIRED',
        `Timestamp is outside the allowed ${this.maxSkewMs} ms window`,
      );
    }

    this.sweep(now);
    if ((this.seen.get(nonce) ?? 0) > now) {
      throw this.reject('REQUEST_REPLAYED', 'Nonce has already been used');
    }

    this.seen.set(nonce, now + this.maxSkewMs);
    if (this.seen.size > this.maxEntries) {
      // Keep the cache bounded even when a burst of unique nonces arrives.
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }

  private reject(code: string, message: string): BadRequestException {
    return new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code,
      message,
    });
  }

  /** Expired nonces can be forgotten; sweeping runs at most once per window. */
  private sweep(now: number): void {
    if (this.seen.size < this.maxEntries / 2) return;
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < SECONDS_THRESHOLD ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric)) return null;
      return numeric < SECONDS_THRESHOLD ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
