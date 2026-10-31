import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { enumValue, strictBoolean } from '../common/config.js';
import { AttestationController } from './attestation.controller.js';
import {
  ATTESTATION_POLICY,
  AttestationPolicy,
  AttestationService,
  SecurityLevel,
} from './attestation.service.js';
import { ChallengeStore } from './challenge.store.js';
import {
  DEVICE_POLICY,
  DevicePolicy,
  DeviceSignatureGuard,
} from './device-signature.guard.js';
import { DeviceRegistry } from './device.registry.js';
import { getGoogleRootKeys } from './google-roots.js';
import {
  KV_STORE,
  KvStore,
  MemoryKvStore,
  UpstashKvStore,
} from './kv.store.js';

/** Normalises a comma-separated list of hex digests: colons optional, case-insensitive. */
function hexSet(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((value) => value.replace(/:/g, '').trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Certificate serials drop insignificant leading zeros. Digests must not use
 * this helper: a SHA-256 digest that starts with 0 is still a real digest.
 */
function serialSet(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((value) =>
        value
          .replace(/:/g, '')
          .trim()
          .toLowerCase()
          .replace(/^0+(?=.)/, ''),
      )
      .filter(Boolean),
  );
}

export function policyFromConfig(config: ConfigService): AttestationPolicy {
  const packageName = (
    config.get<string>('ATTESTATION_PACKAGE_NAME') ||
    config.get<string>('AEGIS_PACKAGE_NAME') ||
    ''
  ).trim();
  const signingCertDigestsRaw =
    config.get<string>('ATTESTATION_SIGNING_CERT_SHA256') ||
    config.get<string>('AEGIS_SIGNING_CERT_SHA256') ||
    '';
  const allowSoftware =
    strictBoolean(config, 'ATTESTATION_ALLOW_SOFTWARE', false) ||
    strictBoolean(config, 'AEGIS_EMULATOR_MODE', false);
  const isProduction =
    (config.get<string>('NODE_ENV') || process.env.NODE_ENV) === 'production';

  // Software mode accepts software attestation from any root, which defeats the
  // entire module. It must never be reachable in production.
  if (allowSoftware && isProduction) {
    throw new Error(
      'ATTESTATION_ALLOW_SOFTWARE must not be true when NODE_ENV=production',
    );
  }

  const signingCertDigests = hexSet(signingCertDigestsRaw);
  for (const digest of signingCertDigests) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `ATTESTATION_SIGNING_CERT_SHA256 must be SHA-256 hex digests (got ${JSON.stringify(digest)})`,
      );
    }
  }

  // Both halves of the app identity are needed to verify anything. Neither set
  // means the module was simply never adopted, and the rest of the gateway must
  // still start; one of the two set is a half-finished configuration, which is a
  // mistake worth failing on.
  const configured = Boolean(packageName) && signingCertDigests.size > 0;
  if (!configured && (packageName || signingCertDigests.size > 0)) {
    throw new Error(
      'ATTESTATION_PACKAGE_NAME and ATTESTATION_SIGNING_CERT_SHA256 must both be set, or both be empty',
    );
  }
  if (!configured && process.env.NODE_ENV !== 'test') {
    Logger.log(
      'Attestation is not configured (ATTESTATION_PACKAGE_NAME / ATTESTATION_SIGNING_CERT_SHA256 unset); /v1/devices endpoints will report 503.',
      'AttestationModule',
    );
  }

  if (allowSoftware) {
    Logger.warn(
      'ATTESTATION_ALLOW_SOFTWARE=true is active: software attestation from any root is accepted (development/test only).',
      'AttestationModule',
    );
  }

  return {
    configured,
    trustedRootPublicKeys: allowSoftware ? null : getGoogleRootKeys(),
    packageName,
    signingCertDigests,
    minSecurityLevel: allowSoftware
      ? SecurityLevel.software
      : SecurityLevel.trustedEnvironment,
    requireVerifiedBoot: !allowSoftware,
    revokedSerials: serialSet(
      config.get<string>('ATTESTATION_REVOKED_SERIALS') ||
        config.get<string>('AEGIS_REVOKED_SERIALS') ||
        '',
    ),
  };
}

/**
 * The attestation module is optional. A half-finished configuration should
 * leave it disabled with a clear error, not take the whole gateway down.
 */
export function safePolicyFromConfig(config: ConfigService): AttestationPolicy {
  try {
    return policyFromConfig(config);
  } catch (err) {
    Logger.error(
      `Attestation disabled: ${(err as Error).message}`,
      'AttestationModule',
    );
    return {
      configured: false,
      trustedRootPublicKeys: [],
      packageName: '',
      signingCertDigests: new Set(),
      minSecurityLevel: SecurityLevel.trustedEnvironment,
      requireVerifiedBoot: true,
      revokedSerials: new Set(),
    };
  }
}

export function devicePolicyFromConfig(config: ConfigService): DevicePolicy {
  const explicit =
    config.get<string>('ATTESTATION_DEVICE_POLICY') ??
    config.get<string>('AEGIS_DEVICE_POLICY');
  if (explicit === undefined) return 'required';
  return enumValue(
    config,
    config.get<string>('ATTESTATION_DEVICE_POLICY') !== undefined
      ? 'ATTESTATION_DEVICE_POLICY'
      : 'AEGIS_DEVICE_POLICY',
    ['required', 'report'] as const,
    'required',
  );
}

export function kvStoreFromConfig(config: ConfigService): KvStore {
  const url = (
    config.get<string>('ATTESTATION_KV_REST_URL') ||
    config.get<string>('AEGIS_KV_REST_URL') ||
    ''
  ).trim();
  const token = (
    config.get<string>('ATTESTATION_KV_REST_TOKEN') ||
    config.get<string>('AEGIS_KV_REST_TOKEN') ||
    ''
  ).trim();
  const isProduction =
    (config.get<string>('NODE_ENV') || process.env.NODE_ENV) === 'production';

  if (url && token) return new UpstashKvStore(url, token);
  if (url || token) {
    throw new Error(
      'ATTESTATION_KV_REST_URL (or AEGIS_KV_REST_URL) and ATTESTATION_KV_REST_TOKEN (or AEGIS_KV_REST_TOKEN) must both be set, or both be empty',
    );
  }

  // In-process state is per-instance: on serverless or multi-instance hosting a
  // device enrolled by one instance is unknown to the next.
  if (isProduction) {
    Logger.warn(
      'Attestation state is in-memory: challenges and enrolments do not survive restarts and are not shared between instances. Set ATTESTATION_KV_REST_URL/ATTESTATION_KV_REST_TOKEN for serverless or multi-instance deployments.',
      'AttestationModule',
    );
  }
  return new MemoryKvStore();
}

export function safeKvStoreFromConfig(config: ConfigService): KvStore {
  try {
    return kvStoreFromConfig(config);
  } catch (err) {
    Logger.error(
      `Attestation state falling back to memory: ${(err as Error).message}`,
      'AttestationModule',
    );
    return new MemoryKvStore();
  }
}

@Module({
  controllers: [AttestationController],
  providers: [
    AttestationService,
    ChallengeStore,
    DeviceRegistry,
    DeviceSignatureGuard,
    {
      provide: KV_STORE,
      useFactory: safeKvStoreFromConfig,
      inject: [ConfigService],
    },
    {
      provide: ATTESTATION_POLICY,
      useFactory: safePolicyFromConfig,
      inject: [ConfigService],
    },
    {
      provide: DEVICE_POLICY,
      useFactory: devicePolicyFromConfig,
      inject: [ConfigService],
    },
  ],
  exports: [
    AttestationService,
    ChallengeStore,
    DeviceRegistry,
    DeviceSignatureGuard,
  ],
})
export class AttestationModule {}
