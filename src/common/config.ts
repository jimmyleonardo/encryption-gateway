import { ConfigService } from '@nestjs/config';

/** Reject typos and disabled/unbounded security limits at startup. */
export function positiveInteger(
  config: ConfigService,
  name: string,
  fallback: number,
): number {
  const raw = config.get<string>(name);
  // Hosting dashboards (e.g. Vercel) pass unset variables as "".
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive safe integer (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/** Only the exact strings "true" and "false" are accepted, so a typo cannot silently disable a control. */
export function strictBoolean(
  config: ConfigService,
  name: string,
  fallback: boolean,
): boolean {
  const raw = config.get<string>(name);
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(
      `${name} must be true or false (got ${JSON.stringify(raw)})`,
    );
  }
  return raw === 'true';
}

/** Restricts a variable to a known set of values, naming the rejected value. */
export function enumValue<const T extends readonly string[]>(
  config: ConfigService,
  name: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const raw = config.get<string>(name);
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!allowed.includes(raw)) {
    throw new Error(
      `${name} must be one of ${allowed.join(', ')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}
