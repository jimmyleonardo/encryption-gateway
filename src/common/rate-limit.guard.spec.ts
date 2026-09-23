import { jest } from '@jest/globals';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard.js';

describe('RateLimitGuard', () => {
  const makeGuard = (env: Record<string, string>, skip = false) => {
    const config = { get: (name: string) => env[name] } as ConfigService;
    const reflector = {
      getAllAndOverride: () => skip,
    } as unknown as Reflector;
    return new RateLimitGuard(reflector, config);
  };

  const makeContext = (ip: string) => {
    const headers: Record<string, unknown> = {};
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ ip, socket: {} }),
        getResponse: () => ({
          setHeader: (name: string, value: unknown) => (headers[name] = value),
        }),
      }),
    } as unknown as ExecutionContext;
    return { context, headers };
  };

  const statusOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as HttpException).getStatus();
    }
    return 200;
  };

  afterEach(() => jest.useRealTimers());

  it('allows up to THROTTLE_LIMIT requests, then answers 429', () => {
    const guard = makeGuard({ THROTTLE_LIMIT: '2', THROTTLE_TTL_MS: '1000' });
    const { context, headers } = makeContext('1.1.1.1');

    expect(guard.canActivate(context)).toBe(true);
    expect(headers['X-RateLimit-Remaining']).toBe(1);
    expect(guard.canActivate(context)).toBe(true);
    expect(statusOf(() => guard.canActivate(context))).toBe(429);
    expect(headers['Retry-After']).toBe(1);
  });

  it('counts each client IP separately', () => {
    const guard = makeGuard({ THROTTLE_LIMIT: '1' });

    expect(guard.canActivate(makeContext('1.1.1.1').context)).toBe(true);
    expect(guard.canActivate(makeContext('2.2.2.2').context)).toBe(true);
    expect(
      statusOf(() => guard.canActivate(makeContext('1.1.1.1').context)),
    ).toBe(429);
  });

  it('starts a new window after THROTTLE_TTL_MS', () => {
    jest.useFakeTimers();
    const guard = makeGuard({ THROTTLE_LIMIT: '1', THROTTLE_TTL_MS: '1000' });
    const { context } = makeContext('1.1.1.1');

    expect(guard.canActivate(context)).toBe(true);
    expect(statusOf(() => guard.canActivate(context))).toBe(429);
    jest.advanceTimersByTime(1000);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('skips routes marked with @SkipRateLimit()', () => {
    const guard = makeGuard({ THROTTLE_LIMIT: '1' }, true);
    const { context } = makeContext('1.1.1.1');

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects invalid limits at startup', () => {
    expect(() => makeGuard({ THROTTLE_LIMIT: '0' })).toThrow(
      'THROTTLE_LIMIT must be a positive safe integer',
    );
  });
});
