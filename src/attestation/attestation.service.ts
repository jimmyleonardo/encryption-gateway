import { Inject, Injectable } from '@nestjs/common';
import {
  KeyObject,
  X509Certificate,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import {
  AttestationApplicationId,
  KeyDescription,
  SecurityLevel,
  VerifiedBootState,
  id_ce_keyDescription,
} from '@peculiar/asn1-android';

// Re-exported so callers configuring a policy do not need the ASN.1 package.
export { SecurityLevel };

/**
 * Requirements that an incoming Android Key Attestation must satisfy.
 */
export interface AttestationPolicy {
  /** False when no app identity is configured at all: the endpoints then report 503 instead of rejecting every chain. */
  configured: boolean;
  /** DER SubjectPublicKeyInfo of trusted roots (e.g. Google). `null` accepts any root (testing/emulator only). */
  trustedRootPublicKeys: Buffer[] | null;
  packageName: string;
  signingCertDigests: Set<string>; // lowercase hex SHA-256 of valid APK signing cert(s)
  minSecurityLevel: number;
  requireVerifiedBoot: boolean;
  revokedSerials: Set<string>; // lowercase hex
}

export const ATTESTATION_POLICY = Symbol('ATTESTATION_POLICY');

/**
 * Thrown when an attestation fails policy requirements.
 */
export class AttestationRejectedError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AttestationRejectedError';
  }
}

const reject = (code: string, detail: string): never => {
  throw new AttestationRejectedError(code, detail);
};

/**
 * Converts ASN.1 OctetString or ArrayBuffer into Node.js Buffer.
 */
const bytes = (value: OctetString | ArrayBuffer): Buffer =>
  value instanceof ArrayBuffer
    ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);

/**
 * Verifies Android Key Attestation chains produced by Android Keystore (TEE / StrongBox).
 */
@Injectable()
export class AttestationService {
  constructor(
    @Inject(ATTESTATION_POLICY)
    private readonly policy: AttestationPolicy,
  ) {}

  /**
   * Verifies the certificate chain against the configured policy and challenge nonce.
   */
  verify(
    chainDer: Buffer[],
    challenge: Buffer,
  ): { publicKey: KeyObject; securityLevel: number } {
    if (chainDer.length < 2) {
      reject('NOT_A_CHAIN', `${chainDer.length} certificate(s)`);
    }
    try {
      return this.verifyChain(chainDer, challenge);
    } catch (e) {
      if (e instanceof AttestationRejectedError) throw e;
      return reject('MALFORMED', String(e));
    }
  }

  private verifyChain(
    chainDer: Buffer[],
    challenge: Buffer,
  ): { publicKey: KeyObject; securityLevel: number } {
    const chain = chainDer.map((der) => new X509Certificate(der));

    // 1. Each certificate is signed by the next; the root is self-signed.
    chain.forEach((cert, i) => {
      const issuer = chain[Math.min(i + 1, chain.length - 1)];
      if (!cert.verify(issuer.publicKey)) {
        reject(
          'CHAIN_SIGNATURE',
          `certificate ${i} is not signed by its issuer`,
        );
      }
    });

    // 2. The chain ends at a trusted root (Google Attestation Root).
    if (this.policy.trustedRootPublicKeys) {
      const rootKey = chain[chain.length - 1].publicKey.export({
        type: 'spki',
        format: 'der',
      }) as Buffer;
      if (
        !this.policy.trustedRootPublicKeys.some((key) => key.equals(rootKey))
      ) {
        const rootCert = chain[chain.length - 1];
        reject(
          'UNTRUSTED_ROOT',
          `root certificate is not a trusted Google Attestation Root (device may be non-GMS or Huawei; issuer: ${rootCert.issuer || rootCert.subject || 'unknown'})`,
        );
      }
    }

    // 3. Every certificate is within its validity period. Checked even in
    // software mode, where the trusted-root check above is skipped.
    const now = new Date();
    chain.forEach((cert, i) => {
      if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
        reject(
          'CHAIN_SIGNATURE',
          `certificate ${i} is outside its validity period`,
        );
      }
    });

    // 4. No certificate is revoked.
    chain.forEach((cert, i) => {
      const serial = cert.serialNumber.toLowerCase().replace(/^0+(?=.)/, '');
      if (this.policy.revokedSerials.has(serial)) {
        reject('REVOKED', `certificate ${i} is revoked`);
      }
    });

    // 5. Inspect the attestation record in the leaf certificate.
    const leaf = AsnConvert.parse(chainDer[0], Certificate);
    const extension = leaf.tbsCertificate.extensions?.find(
      (ext) => ext.extnID === id_ce_keyDescription,
    );
    if (!extension) {
      return reject('MALFORMED', 'no attestation extension');
    }
    const description = AsnConvert.parse(
      bytes(extension.extnValue),
      KeyDescription,
    );

    const attested = bytes(description.attestationChallenge);
    if (
      attested.length !== challenge.length ||
      !timingSafeEqual(attested, challenge)
    ) {
      reject('CHALLENGE_MISMATCH', 'attestation challenge does not match');
    }

    const level = Math.min(
      description.attestationSecurityLevel,
      description.keymasterSecurityLevel,
    );
    if (level < this.policy.minSecurityLevel) {
      reject('SECURITY_LEVEL', `security level ${level}`);
    }

    if (this.policy.requireVerifiedBoot) {
      const rootOfTrust =
        description.teeEnforced.rootOfTrust ??
        reject('MALFORMED', 'no root of trust');
      if (!rootOfTrust.deviceLocked) {
        reject('BOOTLOADER_UNLOCKED', 'bootloader is unlocked');
      }
      if (rootOfTrust.verifiedBootState !== VerifiedBootState.verified) {
        reject(
          'BOOT_NOT_VERIFIED',
          `verified boot state ${rootOfTrust.verifiedBootState}`,
        );
      }
    }

    // 6. The key was created by the authentic app, signed with the authentic certificate.
    // This rejects any MOD / repacked APK.
    // Prefer the hardware-enforced copy when a device provides both; the
    // software-enforced copy is easier to influence on a compromised OS.
    const appIdOctets =
      description.teeEnforced.attestationApplicationId ??
      description.softwareEnforced.attestationApplicationId ??
      reject('MALFORMED', 'no attestation application id');
    const appId = AsnConvert.parse(
      bytes(appIdOctets),
      AttestationApplicationId,
    );
    const packages = appId.packageInfos.map((info) =>
      bytes(info.packageName).toString('utf8'),
    );
    if (!packages.includes(this.policy.packageName)) {
      reject(
        'PACKAGE_MISMATCH',
        `package ${this.policy.packageName} not attested`,
      );
    }
    const digests = appId.signatureDigests.map((digest) =>
      bytes(digest).toString('hex'),
    );
    if (digests.length === 0) {
      reject('SIGNER_NOT_ALLOWED', 'no signing certificate digest');
    }
    for (const digest of digests) {
      if (!this.policy.signingCertDigests.has(digest)) {
        reject(
          'SIGNER_NOT_ALLOWED',
          `signing certificate ${digest} is not allowed`,
        );
      }
    }

    return { publicKey: chain[0].publicKey, securityLevel: level };
  }

  /**
   * Checks a SHA256withECDSA signature (DER), as produced by the enrolled device key.
   */
  verifySignature(
    publicKey: KeyObject,
    data: Buffer,
    signature: Buffer,
  ): boolean {
    try {
      return cryptoVerify('sha256', data, publicKey, signature);
    } catch {
      return false;
    }
  }
}
