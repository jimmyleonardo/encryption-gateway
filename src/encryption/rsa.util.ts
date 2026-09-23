import * as crypto from 'crypto';

/**
 * RSA-OAEP utilities with SHA-256 and MGF1-SHA-256 padding.
 */
export class RsaUtil {
  /**
   * Decrypts an RSA-OAEP-SHA256 ciphertext block (e.g. client's encrypted AES key).
   */
  static decryptOaep(
    encryptedBuffer: Buffer,
    privateKey: crypto.KeyLike,
  ): Buffer {
    return crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedBuffer,
    );
  }

  /**
   * Encrypts a buffer using RSA-OAEP-SHA256 (useful for tests/client simulation).
   */
  static encryptOaep(plainBuffer: Buffer, publicKey: crypto.KeyLike): Buffer {
    return crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      plainBuffer,
    );
  }
}
