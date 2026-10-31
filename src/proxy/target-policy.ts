import { BadRequestException } from '@nestjs/common';

export const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface Rule {
  /** HTTP method, or '*' for any allowed method. */
  method: string;
  /** `URL.host` form: hostname, plus `:port` only when non-default. */
  host: string;
  /** Exact path, or a prefix when `prefix` is true. */
  path: string;
  prefix: boolean;
  source: string;
}

/**
 * Decides which upstream requests the gateway may make.
 *
 *   ALLOWED_TARGET_HOSTS  host-level: any method, any path on the host.
 *       api.example.com, api.example.com:8443
 *
 *   ALLOWED_ROUTES        fine-grained: optional method, host and path;
 *                         a trailing `*` matches any path below it.
 *       POST api.example.com/api/login
 *       GET api.example.com/api/products/*
 *       api.example.com/public/*          (any method)
 *
 * A request is allowed when it matches ANY entry of either list. Both
 * empty = everything is rejected. Invalid entries throw at startup, so
 * a typo can't silently open (or close) the gateway.
 */
export class TargetPolicy {
  private readonly rules: Rule[];

  constructor(allowedHosts = '', allowedRoutes = '') {
    this.rules = [
      ...splitList(allowedHosts).map((e) => parseHostEntry(e)),
      ...splitList(allowedRoutes).map((e) => parseRouteEntry(e)),
    ];
  }

  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  describe(): string[] {
    return this.rules.map((r) => r.source);
  }

  /** Throws 400 unless `method url` matches a rule. */
  assertAllowed(method: string, url: URL): void {
    // Encoded slashes/backslashes could be decoded by the upstream into
    // extra path segments that bypass a path prefix rule.
    if (/%2f|%5c/i.test(url.pathname)) {
      throw new BadRequestException(
        'AccessPoint path must not contain encoded slashes',
      );
    }

    const host = url.host.toLowerCase();
    const allowed = this.rules.some(
      (r) =>
        r.host === host &&
        (r.method === '*' || r.method === method) &&
        (r.prefix ? url.pathname.startsWith(r.path) : url.pathname === r.path),
    );
    if (!allowed) {
      throw new BadRequestException(
        `Target "${method} ${host}${url.pathname}" is not in the allowed list`,
      );
    }
  }
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

function configError(variable: string, entry: string, why: string): Error {
  return new Error(`${variable}: invalid entry "${entry}" — ${why}`);
}

function assertHost(variable: string, entry: string, host: string): string {
  if (host.includes('://')) {
    throw configError(variable, entry, 'remove the scheme (https://)');
  }
  if (!/^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(host)) {
    throw configError(variable, entry, 'expected host or host:port');
  }
  // URL.host omits default ports, so `api.x.com:443` must become
  // `api.x.com` to ever match.
  return host.toLowerCase().replace(/:(443|80)$/, '');
}

function parseHostEntry(entry: string): Rule {
  if (entry.includes('://')) {
    throw configError(
      'ALLOWED_TARGET_HOSTS',
      entry,
      'remove the scheme (https://)',
    );
  }
  if (entry.includes('/')) {
    throw configError(
      'ALLOWED_TARGET_HOSTS',
      entry,
      'hosts only — put paths in ALLOWED_ROUTES',
    );
  }
  return {
    method: '*',
    host: assertHost('ALLOWED_TARGET_HOSTS', entry, entry),
    path: '/',
    prefix: true,
    source: entry,
  };
}

function parseRouteEntry(entry: string): Rule {
  const parts = entry.split(/\s+/);
  if (parts.length > 2) {
    throw configError('ALLOWED_ROUTES', entry, 'expected "[METHOD] host/path"');
  }
  const [method, target] =
    parts.length === 2 ? [parts[0].toUpperCase(), parts[1]] : ['*', parts[0]];

  if (method !== '*' && !ALLOWED_METHODS.includes(method)) {
    throw configError(
      'ALLOWED_ROUTES',
      entry,
      `method must be one of ${ALLOWED_METHODS.join('/')} or *`,
    );
  }

  if (target.includes('://')) {
    throw configError('ALLOWED_ROUTES', entry, 'remove the scheme (https://)');
  }
  const slash = target.indexOf('/');
  if (slash <= 0) {
    throw configError(
      'ALLOWED_ROUTES',
      entry,
      'expected host/path, e.g. api.example.com/api/*',
    );
  }
  const host = assertHost('ALLOWED_ROUTES', entry, target.slice(0, slash));
  const rawPath = target.slice(slash);
  if (rawPath.slice(0, -1).includes('*')) {
    throw configError(
      'ALLOWED_ROUTES',
      entry,
      '`*` is only allowed at the end',
    );
  }
  const prefix = rawPath.endsWith('*');
  // Normalise dot segments the same way incoming URLs are parsed.
  const path = new URL(`https://x${prefix ? rawPath.slice(0, -1) : rawPath}`)
    .pathname;

  return { method, host, path, prefix, source: entry };
}
