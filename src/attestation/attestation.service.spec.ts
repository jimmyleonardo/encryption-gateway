import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AttestationRejectedError,
  AttestationService,
  SecurityLevel,
} from './attestation.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesPath = join(
  __dirname,
  '../../test/fixtures/attestation-fixtures.json',
);
interface AttestationCase {
  name: string;
  expected: string;
  certificateChain: string[];
  challenge: string;
  trustedRootPublicKeys?: string[];
  revokedSerials?: string[];
}

interface SignatureCase {
  name: string;
  publicKey: string;
  data: string;
  signature: string;
  expectedValid: boolean;
}

interface Fixtures {
  policy: {
    trustedRootPublicKeys: string[];
    packageName: string;
    signingCertDigests: string[];
  };
  attestationCases: AttestationCase[];
  signatureCases: SignatureCase[];
}

const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Fixtures;
const b64 = (s: string) => Buffer.from(s, 'base64');

describe('AttestationService', () => {
  describe('Hardware Attestation Verification', () => {
    for (const c of fixtures.attestationCases) {
      it(`evaluates: ${c.name} -> ${c.expected}`, () => {
        const service = new AttestationService({
          configured: true,
          trustedRootPublicKeys: (
            c.trustedRootPublicKeys ?? fixtures.policy.trustedRootPublicKeys
          ).map(b64),
          packageName: fixtures.policy.packageName,
          signingCertDigests: new Set(fixtures.policy.signingCertDigests),
          minSecurityLevel: SecurityLevel.trustedEnvironment,
          requireVerifiedBoot: true,
          revokedSerials: new Set(c.revokedSerials ?? []),
        });

        let got = 'VALID';
        try {
          service.verify(c.certificateChain.map(b64), b64(c.challenge));
        } catch (e: unknown) {
          if (e instanceof AttestationRejectedError) {
            got = e.code;
          } else {
            throw e;
          }
        }
        expect(got).toBe(c.expected);
      });
    }
  });

  describe('Signature Verification', () => {
    for (const c of fixtures.signatureCases) {
      it(`verifies: ${c.name} -> expected ${c.expectedValid}`, () => {
        const service = new AttestationService({} as never);
        const key = createPublicKey({
          key: b64(c.publicKey),
          format: 'der',
          type: 'spki',
        });
        const isValid = service.verifySignature(
          key,
          b64(c.data),
          b64(c.signature),
        );
        expect(isValid).toBe(c.expectedValid);
      });
    }
  });
});
