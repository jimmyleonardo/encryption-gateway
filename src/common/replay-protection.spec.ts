import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReplayProtectionService } from './replay-protection.service.js';

const make = (env: Record<string, string> = {}) =>
  new ReplayProtectionService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

const payload = (overrides: Record<string, unknown> = {}) => ({
  AccessPoint: 'https://api.example.com/x',
  ...overrides,
});

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

describe('ReplayProtectionService', () => {
  it('does nothing unless REQUIRE_REQUEST_NONCE=true', () => {
    expect(() => make().assertFresh(payload(), NOW)).not.toThrow();
  });

  it('requires a nonce when enabled', () => {
    expect(() =>
      make({ REQUIRE_REQUEST_NONCE: 'true' }).assertFresh(payload(), NOW),
    ).toThrow(BadRequestException);
  });

  it('rejects timestamps outside the allowed window', () => {
    const service = make({
      REQUIRE_REQUEST_NONCE: 'true',
      REQUEST_MAX_SKEW_MS: '1000',
    });
    expect(() =>
      service.assertFresh(
        payload({
          Nonce: '0123456789abcdef',
          Timestamp: NOW - 5000,
        }),
        NOW,
      ),
    ).toThrow(/outside the allowed/);
  });

  it('accepts an ISO timestamp and rejects a replay', () => {
    const service = make({ REQUIRE_REQUEST_NONCE: 'true' });
    const fresh = payload({
      Nonce: '0123456789abcdef',
      Timestamp: new Date(NOW).toISOString(),
    });

    expect(() => service.assertFresh(fresh, NOW)).not.toThrow();
    expect(() => service.assertFresh(fresh, NOW + 1)).toThrow(
      /already been used/,
    );
  });

  it('accepts epoch seconds and milliseconds', () => {
    const service = make({ REQUIRE_REQUEST_NONCE: 'true' });
    expect(() =>
      service.assertFresh(
        payload({
          Nonce: '0123456789abcdef',
          Timestamp: Math.floor(NOW / 1000),
        }),
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      service.assertFresh(
        payload({
          Nonce: 'fedcba9876543210',
          Timestamp: NOW,
        }),
        NOW,
      ),
    ).not.toThrow();
  });

  it('rejects malformed nonces and timestamps', () => {
    const service = make({ REQUIRE_REQUEST_NONCE: 'true' });
    expect(() =>
      service.assertFresh(payload({ Nonce: 'short', Timestamp: NOW }), NOW),
    ).toThrow(/Nonce must be/);
    expect(() =>
      service.assertFresh(
        payload({ Nonce: '0123456789abcdef', Timestamp: 'not-a-date' }),
        NOW,
      ),
    ).toThrow(/Timestamp must be/);
  });
});
