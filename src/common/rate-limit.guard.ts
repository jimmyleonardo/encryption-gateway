import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { positiveInteger } from './config.js';

const SKIP_RATE_LIMIT = 'skipRateLimit';

/** Exempts a route or controller from the per-IP rate limit. */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);

/**
 * Fixed-window rate limit per client IP, kept in memory.
 *
 * Replaces @nestjs/throttler, which is CommonJS and require()s the
 * ESM-only NestJS 12 packages — something serverless loaders such as
 * Vercel's cannot do. Counters live in this process only, so on
 * serverless each instance counts separately.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly ttlMs: number;
  private readonly limit: number;
  private readonly maxEntries: number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private nextSweepAt = 0;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.ttlMs = positiveInteger(config, 'THROTTLE_TTL_MS', 60000);
    this.limit = positiveInteger(config, 'THROTTLE_LIMIT', 60);
    this.maxEntries = positiveInteger(config, 'THROTTLE_MAX_ENTRIES', 10000);
  }

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const now = Date.now();
    this.sweep(now);

    let key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (!this.hits.has(key) && this.hits.size >= this.maxEntries - 1) {
      // Keep attacker-controlled IP cardinality from growing this process
      // without bound. New addresses share one capped overflow bucket.
      key = '\u0000rate-limit-overflow';
    }
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.ttlMs };
      this.hits.set(key, entry);
    }
    entry.count++;

    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('X-RateLimit-Limit', this.limit);
    res.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, this.limit - entry.count),
    );
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (entry.count > this.limit) {
      res.setHeader('Retry-After', resetSeconds);
      throw new HttpException(
        'ThrottlerException: Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Drops expired windows at most once per TTL so the map stays bounded. */
  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.ttlMs;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}
