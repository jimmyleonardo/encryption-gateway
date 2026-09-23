import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { gzipSync } from 'node:zlib';
import { AppModule } from './../src/app.module.js';
import { AesUtil } from './../src/encryption/aes.util.js';
import { GatewayResponse } from './../src/encryption/encryption.service.js';

const { publicKey: publicKeyPem, privateKey: privateKeyPem } =
  crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

interface UpstreamHit {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('Gateway (e2e)', () => {
  let upstream: http.Server;
  let port: number;
  let hits: UpstreamHit[] = [];

  const startApp = async (env: Record<string, string>) => {
    const keys = [
      'RSA_PRIVATE_KEY',
      'RSA_PRIVATE_KEY_PATH',
      'ALLOWED_TARGET_HOSTS',
      'ALLOWED_ROUTES',
      'ALLOW_HTTP_UPSTREAM',
      'ENCRYPT_RESPONSE',
    ];
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, {
      RSA_PRIVATE_KEY: privateKeyPem,
      MAX_UPSTREAM_RESPONSE_BYTES: '1024',
      ALLOW_HTTP_UPSTREAM: 'true',
      ...env,
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    // Keep one listener for the suite. Repeated ephemeral listen/close cycles
    // can reuse stale keep-alive sockets on recent Node versions.
    await app.listen(0, '127.0.0.1');
    return app;
  };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        hits.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        if (req.url?.startsWith('/api/redirect')) {
          res.writeHead(302, { Location: 'http://127.0.0.1:1/' }).end();
          return;
        }
        if (req.url?.startsWith('/api/plain-text')) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello from plain text upstream');
          return;
        }
        if (req.url?.startsWith('/api/large')) {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Encoding': 'gzip',
          });
          res.end(gzipSync('x'.repeat(2048)));
          return;
        }
        res.writeHead(req.url?.startsWith('/api/missing') ? 404 : 200, {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
        });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    port = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => upstream.close(resolve));
  });

  beforeEach(() => {
    hits = [];
  });

  describe.each([
    ['default', undefined],
    ['encrypted', 'true'],
    ['plain', 'false'],
  ])('Gateway %s responses', (_label, mode) => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await startApp({
        ALLOWED_ROUTES: `localhost:${port}/api/*`,
        ...(mode === undefined ? {} : { ENCRYPT_RESPONSE: mode }),
      });
    });
    afterAll(() => app.close());

    const seal = (payload: Record<string, unknown>) => {
      const aesKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const body = {
        EncryptedKey: crypto
          .publicEncrypt(
            {
              key: publicKeyPem,
              padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
            },
            aesKey,
          )
          .toString('base64'),
        IV: iv.toString('base64'),
        Payload: AesUtil.seal(
          JSON.stringify({
            ...payload,
          }),
          aesKey,
          iv,
        ).toString('base64'),
      };
      return { aesKey, body };
    };

    const post = (body: object, endpoint = '/api/gateway') =>
      request(app.getHttpServer()).post(endpoint).send(body);

    const open = (res: { body: GatewayResponse }, aesKey: Buffer) => {
      type Result = {
        StatusCode: number;
        Headers: Record<string, string>;
        Data: unknown;
      };
      if (mode === 'false') {
        expect(res.body).toMatchObject({ Encrypted: false });
        expect(res.body).not.toHaveProperty('IV');
        expect(res.body).not.toHaveProperty('Payload');
        return res.body as unknown as Result;
      }
      expect(res.body.Encrypted).toBe(true);
      expect(res.body).not.toHaveProperty('Data');
      return JSON.parse(
        AesUtil.open(
          Buffer.from(res.body.Payload, 'base64'),
          aesKey,
          Buffer.from(res.body.IV, 'base64'),
        ),
      ) as Result;
    };

    it('GET /health returns ok', () =>
      request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok' }));

    it('GET /public-key returns the key in every format + key id', async () => {
      const res = await request(app.getHttpServer())
        .get('/public-key')
        .expect(200);
      const body = res.body as Record<string, unknown>;

      expect((body.pem as string).trim()).toBe(publicKeyPem.trim());
      expect(body.keyId).toMatch(/^[0-9a-f]{16}$/);
      expect(body.acceptedKeyIds).toEqual([body.keyId]);
      expect(Object.keys(body).sort()).toEqual([
        'acceptedKeyIds',
        'algorithm',
        'keyId',
        'pem',
        'pkcs1Base64',
        'sha256Fingerprint',
        'spkiBase64',
      ]);
    });

    it('forwards the request and returns status + headers + body in the configured mode', async () => {
      const { aesKey, body } = seal({
        Header: [{ Key: 'Authorization', Value: 'Bearer x' }],
        Body: { userId: 1, nama: 'Café ☕' },
        Method: 'POST',
        AccessPoint: `http://localhost:${port}/api/profile`,
      });
      const res = await post(body, '/api/gateway').expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      const decrypted = open(res, aesKey);
      expect(decrypted.StatusCode).toBe(200);
      expect(decrypted.Data).toEqual({ ok: true, path: '/api/profile' });
      expect(decrypted.Headers['content-type']).toBe('application/json');
      expect(decrypted.Headers['x-custom-header']).toBe('custom-value');

      expect(hits).toHaveLength(1);
      expect(hits[0].headers.authorization).toBe('Bearer x');
      expect(JSON.parse(hits[0].body)).toEqual({ userId: 1, nama: 'Café ☕' });
    });

    it('also supports alias POST /api/v2/gateway for backward compatibility', async () => {
      const { aesKey, body } = seal({
        AccessPoint: `http://localhost:${port}/api/profile`,
      });
      const res = await post(body, '/api/v2/gateway').expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      const decrypted = open(res, aesKey);
      expect(decrypted.StatusCode).toBe(200);
      expect(decrypted.Data).toEqual({ ok: true, path: '/api/profile' });
    });

    it('preserves DELETE JSON bodies and removes forged proxy headers', async () => {
      const { body } = seal({
        Method: 'DELETE',
        AccessPoint: `http://localhost:${port}/api/items`,
        Body: { ids: [1, 2] },
        Header: {
          Authorization: 'Bearer legitimate-token',
          'X-Forwarded-For': '127.0.0.1',
          Forwarded: 'for=127.0.0.1',
          'X-Real-IP': '127.0.0.1',
          Connection: 'X-Internal',
          'X-Internal': 'secret',
        },
      });
      await post(body).expect(200);
      expect(hits).toHaveLength(1);
      expect(hits[0].method).toBe('DELETE');
      expect(JSON.parse(hits[0].body)).toEqual({ ids: [1, 2] });
      expect(hits[0].headers.authorization).toBe('Bearer legitimate-token');
      for (const header of [
        'x-forwarded-for',
        'forwarded',
        'x-real-ip',
        'x-internal',
      ]) {
        expect(hits[0].headers[header]).toBeUndefined();
      }
    });

    it('rejects oversized upstream responses after decompression', async () => {
      const { body } = seal({
        AccessPoint: `http://localhost:${port}/api/large`,
      });
      const res = await post(body).expect(502);
      expect(res.body).toMatchObject({
        message: 'Failed to reach upstream API',
      });
      expect(hits).toHaveLength(1);
    });

    it('rejects tampered ciphertext before contacting the backend', async () => {
      const { body } = seal({
        AccessPoint: `http://localhost:${port}/api/profile`,
      });
      const bytes = Buffer.from(body.Payload, 'base64');
      bytes[0] ^= 1;
      await post({ ...body, Payload: bytes.toString('base64') }).expect(400);
      expect(hits).toHaveLength(0);
    });

    it('forwards non-JSON plain text upstream response cleanly', async () => {
      const { aesKey, body } = seal({
        AccessPoint: `http://localhost:${port}/api/plain-text`,
      });
      const res = await post(body).expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      const decrypted = open(res, aesKey);
      expect(decrypted.StatusCode).toBe(200);
      expect(decrypted.Data).toBe('Hello from plain text upstream');
      expect(decrypted.Headers['content-type']).toBe('text/plain');
    });

    it('forwards the identical encrypted request twice for the backend to handle', async () => {
      const { body } = seal({
        AccessPoint: `http://localhost:${port}/api/transfer`,
        Method: 'POST',
      });
      await post(body).expect(200);
      await post(body).expect(200);
      expect(hits).toHaveLength(2);
    });

    it('ignores legacy Timestamp and Nonce fields', async () => {
      const { body } = seal({
        AccessPoint: `http://localhost:${port}/api/x`,
        Timestamp: 0,
        Nonce: 'legacy-nonce',
      });
      await post(body).expect(200);
      expect(hits).toHaveLength(1);
    });

    it('passes upstream error status inside the envelope', async () => {
      const { aesKey, body } = seal({
        AccessPoint: `http://localhost:${port}/api/missing`,
      });
      expect(open(await post(body).expect(200), aesKey).StatusCode).toBe(404);
    });

    it('does not follow upstream redirects', async () => {
      const { aesKey, body } = seal({
        AccessPoint: `http://localhost:${port}/api/redirect`,
      });
      expect(open(await post(body).expect(200), aesKey).StatusCode).toBe(302);
    });

    it.each([
      ['a path outside ALLOWED_ROUTES', '/admin'],
      ['a dot-segment escape', '/api/../admin'],
      ['an encoded slash', '/api/..%2Fadmin'],
    ])('rejects %s', async (_label, pathname) => {
      const { body } = seal({
        AccessPoint: `http://localhost:${port}${pathname}`,
      });
      await post(body).expect(400);
      expect(hits).toHaveLength(0);
    });

    it('rejects hosts outside the whitelist', async () => {
      const { body } = seal({
        AccessPoint: 'http://169.254.169.254/latest/meta-data',
      });
      await post(body).expect(400);
    });

    it('rejects unencrypted requests in either response mode', async () => {
      await post({
        AccessPoint: `http://localhost:${port}/api/profile`,
      }).expect(400);
      expect(hits).toHaveLength(0);
    });

    it('does not let a request override the response encryption policy', async () => {
      const { body } = seal({
        AccessPoint: `http://localhost:${port}/api/profile`,
      });
      await post({ ...body, Encrypted: false }).expect(400);
      expect(hits).toHaveLength(0);
    });

    it('rejects a body that is not base64', () =>
      post({ EncryptedKey: '!!', IV: '!!', Payload: '!!' }).expect(400));
  });
});
