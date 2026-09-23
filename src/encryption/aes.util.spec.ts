import { AesUtil } from './aes.util.js';

describe('AesUtil', () => {
  it('round-trips with a buffer or base64 key', () => {
    const text = JSON.stringify({ hello: 'dunia', n: 42 });
    const { key, iv, cipherText, authTag } = AesUtil.encrypt(text);

    expect(AesUtil.decrypt(cipherText, key, iv, authTag)).toBe(text);
    expect(
      AesUtil.decrypt(cipherText, key.toString('base64'), iv, authTag),
    ).toBe(text);
  });

  it('uses a fresh key and IV every call', () => {
    const a = AesUtil.encrypt('same');
    const b = AesUtil.encrypt('same');

    expect(a.key.equals(b.key)).toBe(false);
    expect(a.iv).not.toBe(b.iv);
  });

  it('rejects tampered ciphertext', () => {
    const { key, iv, cipherText, authTag } = AesUtil.encrypt('secret data');
    const tampered = Buffer.from(cipherText, 'base64');
    tampered[0] ^= 0xff;

    expect(() =>
      AesUtil.decrypt(tampered.toString('base64'), key, iv, authTag),
    ).toThrow();
  });
});
