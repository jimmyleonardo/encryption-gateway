import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RsaUtil } from './rsa.util.js';
import { AesUtil } from './aes.util.js';
import { DecryptedPayload, parsePayload } from '../common/payload.js';
import { GatewayRequestDto } from '../common/dto/gateway-request.dto.js';

/** Gateway response: encrypted with the client's own AES key. */
export interface GatewayResponse {
  Encrypted: true;
  IV: string; // base64, 12 bytes
  Payload: string; // base64, ciphertext + 16-byte GCM tag
}

export type GatewayV2Response = GatewayResponse;

/** The server public key in every format client apps need. */
export interface PublicKeyInfo {
  /** Send as `KeyId` in requests. */
  keyId: string;
  algorithm: string;
  /** SPKI PEM — Web, Flutter, Android. */
  pem: string;
  /** base64 DER X.509 SubjectPublicKeyInfo — Java `X509EncodedKeySpec`. */
  spkiBase64: string;
  /** base64 DER PKCS#1 — iOS `SecKeyCreateWithData`. */
  pkcs1Base64: string;
  /** SHA-256 of the SPKI DER, to verify the key a client embedded. */
  sha256Fingerprint: string;
  /** Every key id the gateway currently accepts (primary first). */
  acceptedKeyIds: string[];
}

interface ServerKey {
  keyId: string;
  privateKey: crypto.KeyObject;
  info: Omit<PublicKeyInfo, 'acceptedKeyIds'>;
}

const MIN_KEY_BITS = 2048;
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Key id = first 16 hex chars of SHA-256(SPKI DER). */
export function keyIdOf(spkiDer: Buffer): string {
  return crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  /** Primary (newest) key first; older keys stay accepted for rotation. */
  private keys: ServerKey[] = [];

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.keys = this.loadPrivateKeys().map((k) => this.describeKey(k));

    const [primary, ...older] = this.keys;
    this.logger.log(
      `🔑 Primary key ${primary.keyId} (${primary.info.algorithm})` +
        (older.length
          ? `; also accepting ${older.map((k) => k.keyId).join(', ')}`
          : ''),
    );
  }

  getPublicKeyPem(): string {
    return this.keys[0].info.pem;
  }

  getPublicKeyInfo(): PublicKeyInfo {
    return {
      ...this.keys[0].info,
      acceptedKeyIds: this.keys.map((k) => k.keyId),
    };
  }

  /**
   * Decrypts a gateway request: RSA-OAEP-SHA256 -> AES key, then AES-256-GCM -> payload JSON.
   * Returns the decrypted payload and the AES key (which is reused to encrypt the response).
   */
  decrypt(dto: GatewayRequestDto): {
    payload: DecryptedPayload;
    aesKey: Buffer;
  } {
    const key = dto.KeyId
      ? this.keys.find((k) => k.keyId === dto.KeyId)
      : this.keys[0];
    if (!key) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'UNKNOWN_KEY_ID',
        message: `KeyId "${dto.KeyId}" is not accepted by this gateway`,
      });
    }

    let aesKey: Buffer;
    try {
      aesKey = RsaUtil.decryptOaep(
        Buffer.from(dto.EncryptedKey, 'base64'),
        key.privateKey,
      );
    } catch {
      throw new BadRequestException(
        'Unable to decrypt EncryptedKey (wrong public key or not RSA-OAEP-SHA256)',
      );
    }

    const iv = Buffer.from(dto.IV, 'base64');
    const sealed = Buffer.from(dto.Payload, 'base64');
    if (
      aesKey.length !== AES_KEY_BYTES ||
      iv.length !== GCM_IV_BYTES ||
      sealed.length < GCM_TAG_BYTES
    ) {
      throw new BadRequestException(
        'Expected a 32-byte AES key, 12-byte IV and a GCM-sealed Payload',
      );
    }

    let json: string;
    try {
      json = AesUtil.open(sealed, aesKey, iv);
    } catch {
      throw new BadRequestException(
        'Unable to decrypt Payload (AES-GCM authentication failed)',
      );
    }

    return {
      payload: parsePayload(this.parseJson(json)),
      aesKey,
    };
  }

  /**
   * Encrypts the response using the client's own AES key.
   */
  encryptResponse(payload: unknown, aesKey: Buffer): GatewayResponse {
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    return {
      Encrypted: true,
      IV: iv.toString('base64'),
      Payload: AesUtil.seal(JSON.stringify(payload), aesKey, iv).toString(
        'base64',
      ),
    };
  }

  // Backward-compatibility aliases
  decryptV2(dto: GatewayRequestDto) {
    return this.decrypt(dto);
  }

  encryptV2Response(payload: unknown, aesKey: Buffer) {
    return this.encryptResponse(payload, aesKey);
  }

  // ── Key Loading ──────────────────────────────────────────────────────

  /**
   * Loads the server private key(s).
   * Supports:
   *   - RSA_PRIVATE_KEY: base64 string or raw PEM
   *   - RSA_PRIVATE_KEY_PATH: file path(s)
   *   - keys/private.pem (auto-discovered)
   *   - Auto-generates keys if none found and not in test environment!
   */
  private loadPrivateKeys(): { key: crypto.KeyObject; source: string }[] {
    const inline = this.configService.get<string>('RSA_PRIVATE_KEY')?.trim();
    const paths = this.configService
      .get<string>('RSA_PRIVATE_KEY_PATH')
      ?.trim();

    let pems: { pem: string; source: string }[] = [];

    if (inline) {
      pems = inline.includes('-----BEGIN')
        ? [{ pem: inline.replace(/\\n/g, '\n'), source: 'RSA_PRIVATE_KEY' }]
        : inline
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
            .map((v, i) => ({
              pem: Buffer.from(v, 'base64').toString('utf-8'),
              source: `RSA_PRIVATE_KEY[${i}]`,
            }));
    } else if (paths) {
      pems = paths
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const fullPath = path.resolve(process.cwd(), p);
          const source = `RSA_PRIVATE_KEY_PATH (${fullPath})`;
          try {
            return { pem: fs.readFileSync(fullPath, 'utf-8'), source };
          } catch (err) {
            throw new Error(`Cannot read ${source}: ${(err as Error).message}`);
          }
        });
    } else {
      // Check default keys/ folder
      const defaultDir = path.resolve(process.cwd(), 'keys');
      const defaultPrivate = path.join(defaultDir, 'private.pem');

      if (fs.existsSync(defaultPrivate)) {
        pems = [
          {
            pem: fs.readFileSync(defaultPrivate, 'utf-8'),
            source: 'keys/private.pem',
          },
        ];
      } else if (
        process.env.NODE_ENV !== 'test' &&
        this.configService.get<string>('AUTO_GENERATE_KEYS') !== 'false'
      ) {
        // Auto-generate key pair on first start!
        this.logger.warn(
          'No RSA key found in environment or keys/ directory. Generating a fresh RSA-2048 key pair automatically...',
        );
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
          modulusLength: 2048,
        });
        const privatePem = privateKey.export({
          type: 'pkcs8',
          format: 'pem',
        }) as string;
        const publicPem = publicKey.export({
          type: 'spki',
          format: 'pem',
        }) as string;

        fs.mkdirSync(defaultDir, { recursive: true });
        fs.writeFileSync(defaultPrivate, privatePem, { mode: 0o600 });
        fs.writeFileSync(path.join(defaultDir, 'public.pem'), publicPem);

        this.logger.log(
          `✨ Automatically generated RSA-2048 key pair saved to ${defaultPrivate}`,
        );
        pems = [
          {
            pem: privatePem,
            source: 'auto-generated (keys/private.pem)',
          },
        ];
      }
    }

    if (pems.length === 0) {
      throw new Error(
        'No server key configured. Set RSA_PRIVATE_KEY (base64 PEM) or ' +
          'RSA_PRIVATE_KEY_PATH. Generate one with `npm run keygen`.',
      );
    }

    return pems.map(({ pem, source }) => {
      let key: crypto.KeyObject;
      try {
        key = crypto.createPrivateKey(pem);
      } catch (err) {
        throw new Error(
          `${source} is not a valid PEM private key: ${(err as Error).message}`,
        );
      }
      const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
      if (key.asymmetricKeyType !== 'rsa' || bits < MIN_KEY_BITS) {
        throw new Error(`${source} must be an RSA key >= ${MIN_KEY_BITS} bits`);
      }
      return { key, source };
    });
  }

  private describeKey({ key }: { key: crypto.KeyObject }): ServerKey {
    const publicKey = crypto.createPublicKey(key);
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const keyId = keyIdOf(spki);
    return {
      keyId,
      privateKey: key,
      info: {
        keyId,
        algorithm: `RSA-${publicKey.asymmetricKeyDetails?.modulusLength}`,
        pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        spkiBase64: spki.toString('base64'),
        pkcs1Base64: publicKey
          .export({ type: 'pkcs1', format: 'der' })
          .toString('base64'),
        sha256Fingerprint: crypto
          .createHash('sha256')
          .update(spki)
          .digest('hex'),
      },
    };
  }

  private parseJson(json: string): unknown {
    try {
      return JSON.parse(json);
    } catch {
      throw new BadRequestException('Decrypted payload is not valid JSON');
    }
  }
}
