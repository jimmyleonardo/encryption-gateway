import { BadRequestException } from '@nestjs/common';

/**
 * The request a client wants the gateway to make, once decrypted.
 */
export interface DecryptedPayload {
  AccessPoint: string;
  Method?: string;
  Header?: Record<string, unknown>[] | Record<string, unknown>;
  /** JSON string or any JSON value, sent as the body. */
  Body?: unknown;
  /** JSON string or an object, sent as the query string. */
  Parameter?: string | Record<string, unknown>;
}

/**
 * Validates the decrypted JSON and narrows it to DecryptedPayload.
 * Throws 400 with a message that says which field is wrong.
 */
export function parsePayload(value: unknown): DecryptedPayload {
  const fail = (reason: string) =>
    new BadRequestException(`Invalid payload: ${reason}`);

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('must be a JSON object');
  }
  const p = value as Record<string, unknown>;

  if (typeof p.AccessPoint !== 'string' || !p.AccessPoint) {
    throw fail('AccessPoint must be a non-empty string');
  }
  if (p.Method != null && typeof p.Method !== 'string') {
    throw fail('Method must be a string');
  }
  if (p.Header != null && typeof p.Header !== 'object') {
    throw fail('Header must be an array or object');
  }
  if (Array.isArray(p.Header)) {
    if (p.Header.length > 100)
      throw fail('Header must contain at most 100 entries');
    for (const [index, entry] of p.Header.entries()) {
      if (!isRecord(entry)) throw fail(`Header[${index}] must be an object`);
      if ('Key' in entry || 'Value' in entry) {
        if (typeof entry.Key !== 'string' || !isHeaderScalar(entry.Value)) {
          throw fail(
            `Header[${index}] must have a string Key and scalar Value`,
          );
        }
      } else {
        validateHeaderMap(entry, fail, `Header[${index}]`);
      }
    }
  } else if (p.Header != null) {
    validateHeaderMap(p.Header as Record<string, unknown>, fail, 'Header');
  }
  if (
    p.Parameter != null &&
    typeof p.Parameter !== 'string' &&
    (typeof p.Parameter !== 'object' || Array.isArray(p.Parameter))
  ) {
    throw fail('Parameter must be a JSON string or an object');
  }
  if (typeof p.Parameter === 'object' && p.Parameter !== null) {
    validateParameters(p.Parameter as Record<string, unknown>, fail);
  }
  if (p.Body !== undefined) validateJsonDepth(p.Body, fail, 0);

  return p as unknown as DecryptedPayload;
}

type Fail = (reason: string) => BadRequestException;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHeaderScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export function validateParameterObject(
  value: unknown,
): asserts value is Record<string, unknown> {
  const fail = (reason: string) =>
    new BadRequestException(`Invalid payload: ${reason}`);
  if (!isRecord(value)) throw fail('Parameter must decode to an object');
  validateParameters(value, fail);
}

function validateHeaderMap(
  value: Record<string, unknown>,
  fail: Fail,
  label: string,
): void {
  const entries = Object.entries(value);
  if (entries.length > 100)
    throw fail(`${label} must contain at most 100 entries`);
  for (const [name, item] of entries) {
    if (
      name.length > 256 ||
      !isHeaderScalar(item) ||
      String(item).length > 8192
    ) {
      throw fail(
        `${label} entries must have names up to 256 characters and scalar values up to 8192 characters`,
      );
    }
  }
}

function validateParameters(value: Record<string, unknown>, fail: Fail): void {
  if (Object.keys(value).length > 100)
    throw fail('Parameter must contain at most 100 entries');
  for (const [name, item] of Object.entries(value)) {
    const items = Array.isArray(item) ? item : [item];
    if (
      name.length > 256 ||
      items.length > 100 ||
      items.some(
        (v) => v !== null && (!isHeaderScalar(v) || String(v).length > 8192),
      )
    ) {
      throw fail(
        'Parameter must contain scalar values or arrays of scalar values',
      );
    }
  }
}

function validateJsonDepth(value: unknown, fail: Fail, depth: number): void {
  if (depth > 32) throw fail('Body nesting must not exceed 32 levels');
  if (Array.isArray(value)) {
    for (const item of value) validateJsonDepth(item, fail, depth + 1);
  } else if (isRecord(value)) {
    for (const item of Object.values(value))
      validateJsonDepth(item, fail, depth + 1);
  }
}
