import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'node:os';
import { AesUtil } from './aes.util.js';
import { EncryptionService, keyIdOf } from './encryption.service.js';

const keysDir = fs.mkdtempSync(path.join(tmpdir(), 'gateway-test-keys-'));
const fixture = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(
  path.join(keysDir, 'private.pem'),
  fixture.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(keysDir, 'public.pem'),
  fixture.publicKey.export({ type: 'spki', format: 'pem' }),
);
afterAll(() => fs.rmSync(keysDir, { recursive: true, force: true }));

const rsaPair = (bits = 2048) =>
  crypto.generateKeyPairSync('rsa', { modulusLength: bits });

describe('EncryptionService', () => {
  const makeService = (env: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      RSA_PRIVATE_KEY_PATH: path.join(keysDir, 'private.pem'),
      ...env,
    };
    const service = new EncryptionService({
      get: (k: string) => values[k],
    } as unknown as ConfigService);
    service.onModuleInit();
    return service;
  };

  describe('key loading', () => {
    const demoPrivatePem = fs.readFileSync(
      path.join(keysDir, 'private.pem'),
      'utf-8',
    );
    const demoPublicPem = fs.readFileSync(
      path.join(keysDir, 'public.pem'),
      'utf-8',
    );

    it('derives the public key from the private key file', () => {
      const info = makeService().getPublicKeyInfo();

      expect(info.pem.trim()).toBe(demoPublicPem.trim());
      expect(info.algorithm).toBe('RSA-2048');
      expect(info.sha256Fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(
        crypto
          .createPublicKey({
            key: Buffer.from(info.pkcs1Base64, 'base64'),
            format: 'der',
            type: 'pkcs1',
          })
          .export({ type: 'spki', format: 'pem' }),
      ).toBe(info.pem);
    });

    it.each([
      ['base64 of the PEM', Buffer.from(demoPrivatePem).toString('base64')],
      ['raw PEM', demoPrivatePem],
      ['PEM with escaped \\n', demoPrivatePem.replace(/\n/g, '\\n')],
    ])('loads RSA_PRIVATE_KEY given as %s', (_label, value) => {
      const service = makeService({
        RSA_PRIVATE_KEY: value,
        RSA_PRIVATE_KEY_PATH: '/does/not/exist.pem',
      });
      expect(service.getPublicKeyPem().trim()).toBe(demoPublicPem.trim());
    });

    it('fails fast with a helpful message when no key is configured', () => {
      expect(() => makeService({ RSA_PRIVATE_KEY_PATH: '' })).toThrow(
        /npm run keygen/,
      );
    });

    it('rejects a key smaller than 2048 bits', () => {
      const small = rsaPair(1024)
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      expect(() => makeService({ RSA_PRIVATE_KEY: small })).toThrow(
        />= 2048 bits/,
      );
    });
  });

  describe('gateway encryption & decryption', () => {
    /** What a client does: AES-GCM the payload, RSA-OAEP the key. */
    const seal = (
      payload: unknown,
      serverPublicPem: string,
      opts: { keyId?: string; aesKey?: Buffer } = {},
    ) => {
      const aesKey = opts.aesKey ?? crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const sealed = AesUtil.seal(JSON.stringify(payload), aesKey, iv);
      return {
        aesKey,
        dto: {
          KeyId: opts.keyId,
          EncryptedKey: crypto
            .publicEncrypt(
              {
                key: serverPublicPem,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256',
              },
              aesKey,
            )
            .toString('base64'),
          IV: iv.toString('base64'),
          Payload: sealed.toString('base64'),
        },
      };
    };

    const fresh = {
      AccessPoint: 'https://api.example.com/x',
    };

    it('round-trips request and response with the client AES key', () => {
      const service = makeService();
      const payload = { ...fresh, Body: { nama: 'Café ☕' } };
      const { dto, aesKey } = seal(payload, service.getPublicKeyPem());

      const decrypted = service.decrypt(dto);
      expect(decrypted.payload).toEqual(payload);
      expect(decrypted.aesKey.equals(aesKey)).toBe(true);

      const res = service.encryptResponse({ StatusCode: 201 }, aesKey);
      expect(res.IV).not.toBe(dto.IV);
      expect(
        JSON.parse(
          AesUtil.open(
            Buffer.from(res.Payload, 'base64'),
            aesKey,
            Buffer.from(res.IV, 'base64'),
          ),
        ),
      ).toEqual({ StatusCode: 201 });
    });

    it('accepts payloads without Timestamp and Nonce', () => {
      const service = makeService();
      const { dto } = seal(
        { AccessPoint: 'https://x' },
        service.getPublicKeyPem(),
      );
      expect(service.decrypt(dto).payload).toEqual({
        AccessPoint: 'https://x',
      });
    });

    it('rejects a tampered Payload (GCM authentication)', () => {
      const service = makeService();
      const { dto } = seal(fresh, service.getPublicKeyPem());
      const bytes = Buffer.from(dto.Payload, 'base64');
      bytes[0] ^= 1;
      expect(() =>
        service.decrypt({ ...dto, Payload: bytes.toString('base64') }),
      ).toThrow(/authentication failed/);
    });

    it('rejects a key encrypted with PKCS#1 v1.5 instead of OAEP', () => {
      const service = makeService();
      const { dto, aesKey } = seal(fresh, service.getPublicKeyPem());
      dto.EncryptedKey = crypto
        .publicEncrypt(
          {
            key: service.getPublicKeyPem(),
            padding: crypto.constants.RSA_PKCS1_PADDING,
          },
          aesKey,
        )
        .toString('base64');
      expect(() => service.decrypt(dto)).toThrow(BadRequestException);
    });

    it('rejects an AES key that is not 32 bytes', () => {
      const service = makeService();
      const { dto } = seal(fresh, service.getPublicKeyPem());
      dto.EncryptedKey = crypto
        .publicEncrypt(
          {
            key: service.getPublicKeyPem(),
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
          },
          crypto.randomBytes(16),
        )
        .toString('base64');
      expect(() => service.decrypt(dto)).toThrow(/32-byte AES key/);
    });

    it('rejects an unknown KeyId', () => {
      const service = makeService();
      const { dto } = seal(fresh, service.getPublicKeyPem(), {
        keyId: 'ffffffffffffffff',
      });
      expect(() => service.decrypt(dto)).toThrow(BadRequestException);
    });
  });

  describe('key rotation', () => {
    const toB64 = (k: crypto.KeyObject) =>
      Buffer.from(k.export({ type: 'pkcs8', format: 'pem' })).toString(
        'base64',
      );
    const newKey = rsaPair();
    const oldKey = rsaPair();
    const service = () =>
      makeService({
        RSA_PRIVATE_KEY: `${toB64(newKey.privateKey)},${toB64(oldKey.privateKey)}`,
      });
    const idOf = (k: crypto.KeyObject) =>
      keyIdOf(k.export({ type: 'spki', format: 'der' }));

    it('serves the first key as primary and lists all accepted ids', () => {
      const info = service().getPublicKeyInfo();
      expect(info.keyId).toBe(idOf(newKey.publicKey));
      expect(info.acceptedKeyIds).toEqual([
        idOf(newKey.publicKey),
        idOf(oldKey.publicKey),
      ]);
    });

    it('accepts requests made with the old key', () => {
      const aesKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const dto = {
        KeyId: idOf(oldKey.publicKey),
        EncryptedKey: crypto
          .publicEncrypt(
            {
              key: oldKey.publicKey,
              padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
            },
            aesKey,
          )
          .toString('base64'),
        IV: iv.toString('base64'),
        Payload: AesUtil.seal(
          JSON.stringify({
            AccessPoint: 'https://x',
          }),
          aesKey,
          iv,
        ).toString('base64'),
      };
      expect(service().decrypt(dto).payload.AccessPoint).toBe('https://x');
    });
  });
});
