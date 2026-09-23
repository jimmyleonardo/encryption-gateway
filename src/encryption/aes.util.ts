import * as crypto from 'crypto';

export interface AesEncryptResult {
  key: Buffer; // raw AES key (to be RSA-encrypted separately)
  iv: string; // base64
  cipherText: string; // base64
  authTag: string; // base64
}

/**
 * AES-256-GCM helpers used for the "envelope encryption" scheme on the
 * response side: a fresh AES key is generated per request, used to
 * encrypt the (potentially large) upstream API response, and the AES
 * key itself is then wrapped with the client's RSA public key so only
 * the intended client can recover it.
 */
export class AesUtil {
  static encrypt(plainText: string): AesEncryptResult {
    const key = crypto.randomBytes(32); // 256-bit
    const iv = crypto.randomBytes(12); // 96-bit, recommended for GCM

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf-8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return {
      key,
      iv: iv.toString('base64'),
      cipherText: encrypted.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  /**
   * v2 format: ciphertext with the 16-byte GCM tag appended — what
   * WebCrypto, Java `AES/GCM/NoPadding` and pointycastle produce.
   */
  static seal(plainText: string, key: Buffer, iv: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([
      cipher.update(plainText, 'utf-8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }

  /** Inverse of `seal`. Throws if the data or tag was tampered with. */
  static open(sealed: Buffer, key: Buffer, iv: Buffer): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]).toString('utf-8');
  }

  static decrypt(
    cipherTextB64: string,
    keyB64OrBuffer: string | Buffer,
    ivB64: string,
    authTagB64: string,
  ): string {
    const key = Buffer.isBuffer(keyB64OrBuffer)
      ? keyB64OrBuffer
      : Buffer.from(keyB64OrBuffer, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const cipherText = Buffer.from(cipherTextB64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(cipherText),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  }
}
