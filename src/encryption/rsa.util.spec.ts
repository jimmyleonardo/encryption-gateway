import * as crypto from 'crypto';
import { RsaUtil } from './rsa.util.js';

describe('RsaUtil', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  it('encrypts and decrypts a 32-byte AES key using RSA-OAEP-SHA256', () => {
    const rawKey = crypto.randomBytes(32);
    const encrypted = RsaUtil.encryptOaep(rawKey, publicKey);

    expect(encrypted).toHaveLength(256); // 2048 bits = 256 bytes

    const decrypted = RsaUtil.decryptOaep(encrypted, privateKey);
    expect(decrypted.equals(rawKey)).toBe(true);
  });

  it('fails to decrypt if ciphertext was encrypted with another key', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rawKey = crypto.randomBytes(32);
    const foreign = RsaUtil.encryptOaep(rawKey, other.publicKey);

    expect(() => RsaUtil.decryptOaep(foreign, privateKey)).toThrow();
  });
});
