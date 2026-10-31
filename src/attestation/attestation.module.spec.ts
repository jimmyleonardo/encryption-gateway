import { ConfigService } from '@nestjs/config';
import {
  devicePolicyFromConfig,
  kvStoreFromConfig,
  policyFromConfig,
  safeKvStoreFromConfig,
  safePolicyFromConfig,
} from './attestation.module.js';
import { MemoryKvStore, UpstashKvStore } from './kv.store.js';

const DIGEST = 'a'.repeat(64);

/** Minimal ConfigService stand-in backed by a plain record. */
const configOf = (values: Record<string, string>): ConfigService =>
  ({ get: (key: string) => values[key] }) as ConfigService;

describe('policyFromConfig', () => {
  const base = {
    ATTESTATION_PACKAGE_NAME: 'com.example.app',
    ATTESTATION_SIGNING_CERT_SHA256: DIGEST,
  };

  it('trusts the Google roots and demands verified boot by default', () => {
    const policy = policyFromConfig(configOf(base));
    expect(policy.trustedRootPublicKeys).not.toBeNull();
    expect(policy.requireVerifiedBoot).toBe(true);
    expect(policy.packageName).toBe('com.example.app');
    expect(policy.signingCertDigests.has(DIGEST)).toBe(true);
  });

  it('strips colons and lowercases signing cert digests', () => {
    const spaced = DIGEST.toUpperCase().replace(/(..)/g, '$1:').slice(0, -1);
    const policy = policyFromConfig(
      configOf({ ...base, ATTESTATION_SIGNING_CERT_SHA256: spaced }),
    );
    expect(policy.signingCertDigests.has(DIGEST)).toBe(true);
  });

  it('accepts several comma-separated signing certs', () => {
    const second = 'b'.repeat(64);
    const policy = policyFromConfig(
      configOf({
        ...base,
        ATTESTATION_SIGNING_CERT_SHA256: `${DIGEST},${second}`,
      }),
    );
    expect(policy.signingCertDigests.size).toBe(2);
  });

  it('rejects a signing cert digest that is not SHA-256 hex', () => {
    expect(() =>
      policyFromConfig(
        configOf({ ...base, ATTESTATION_SIGNING_CERT_SHA256: 'not-a-digest' }),
      ),
    ).toThrow(/ATTESTATION_SIGNING_CERT_SHA256/);
  });

  it('rejects a non-boolean software mode rather than treating it as false', () => {
    expect(() =>
      policyFromConfig(
        configOf({ ...base, ATTESTATION_ALLOW_SOFTWARE: 'TRUE' }),
      ),
    ).toThrow(/ATTESTATION_ALLOW_SOFTWARE must be true or false/);
  });

  it('relaxes the policy in software mode outside production', () => {
    const policy = policyFromConfig(
      configOf({ ...base, ATTESTATION_ALLOW_SOFTWARE: 'true' }),
    );
    expect(policy.trustedRootPublicKeys).toBeNull();
    expect(policy.requireVerifiedBoot).toBe(false);
  });

  it('refuses to start with software mode in production', () => {
    expect(() =>
      policyFromConfig(
        configOf({
          ...base,
          ATTESTATION_ALLOW_SOFTWARE: 'true',
          NODE_ENV: 'production',
        }),
      ),
    ).toThrow(/must not be true when NODE_ENV=production/);
  });

  it('stays unconfigured, without throwing, when neither is set', () => {
    // The rest of the gateway must still boot when attestation was never adopted.
    const policy = policyFromConfig(configOf({ NODE_ENV: 'production' }));
    expect(policy.configured).toBe(false);
  });

  it('is configured when both halves are present', () => {
    expect(policyFromConfig(configOf(base)).configured).toBe(true);
  });

  it('rejects a half-configured app identity', () => {
    expect(() =>
      policyFromConfig(
        configOf({ ATTESTATION_PACKAGE_NAME: 'com.example.app' }),
      ),
    ).toThrow(/must both be set/);
    expect(() =>
      policyFromConfig(configOf({ ATTESTATION_SIGNING_CERT_SHA256: DIGEST })),
    ).toThrow(/must both be set/);
  });

  it('reads revoked serials as a normalised set', () => {
    const policy = policyFromConfig(
      configOf({
        ...base,
        ATTESTATION_REVOKED_SERIALS: 'AB:CD, ef, 0000AB',
      }),
    );
    expect(policy.revokedSerials).toEqual(new Set(['abcd', 'ef', 'ab']));
  });
});

describe('devicePolicyFromConfig', () => {
  it('defaults to required', () => {
    expect(devicePolicyFromConfig(configOf({}))).toBe('required');
  });

  it('accepts report', () => {
    expect(
      devicePolicyFromConfig(configOf({ ATTESTATION_DEVICE_POLICY: 'report' })),
    ).toBe('report');
  });

  it('rejects an unknown policy, naming the rejected value', () => {
    expect(() =>
      devicePolicyFromConfig(
        configOf({ ATTESTATION_DEVICE_POLICY: 'Required' }),
      ),
    ).toThrow(/ATTESTATION_DEVICE_POLICY must be one of required, report/);
  });
});

describe('kvStoreFromConfig', () => {
  it('falls back to memory when no KV is configured', () => {
    expect(kvStoreFromConfig(configOf({}))).toBeInstanceOf(MemoryKvStore);
  });

  it('uses the REST store when url and token are both present', () => {
    const kv = kvStoreFromConfig(
      configOf({
        ATTESTATION_KV_REST_URL: 'https://kv.example.com',
        ATTESTATION_KV_REST_TOKEN: 'token',
      }),
    );
    expect(kv).toBeInstanceOf(UpstashKvStore);
  });

  it('rejects a half-configured KV rather than silently using memory', () => {
    expect(() =>
      kvStoreFromConfig(
        configOf({ ATTESTATION_KV_REST_URL: 'https://kv.example.com' }),
      ),
    ).toThrow(/must both be set/);
  });
});

describe('safe configuration', () => {
  it('disables attestation instead of crashing on a half-configured identity', () => {
    const policy = safePolicyFromConfig(
      configOf({ ATTESTATION_PACKAGE_NAME: 'com.example.app' }),
    );
    expect(policy.configured).toBe(false);
    expect(policy.trustedRootPublicKeys).toEqual([]);
  });

  it('falls back to memory instead of crashing on a half-configured KV', () => {
    expect(
      safeKvStoreFromConfig(
        configOf({ ATTESTATION_KV_REST_URL: 'https://kv.example.com' }),
      ),
    ).toBeInstanceOf(MemoryKvStore);
  });
});
