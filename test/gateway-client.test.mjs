import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  generateKeyPairSync,
  privateDecrypt,
  createDecipheriv,
  createCipheriv,
  randomBytes,
  constants,
} from 'node:crypto';

// Load the actual browser SDK without changing the Nest application's module type.
const source = await readFile(
  new URL('../clients/web/gatewayClient.js', import.meta.url),
  'utf8',
);
const { GatewayClient } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const result = {
  StatusCode: 401,
  Headers: { 'set-cookie': ['a=1', 'b=2'] },
  Data: { message: 'Login required' },
};

function mockGateway(t, mode, change = (value) => value) {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(
      request.AccessPoint,
      undefined,
      'request must never be sent as plaintext',
    );
    const aesKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(request.EncryptedKey, 'base64'),
    );
    const bytes = Buffer.from(request.Payload, 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      aesKey,
      Buffer.from(request.IV, 'base64'),
    );
    decipher.setAuthTag(bytes.subarray(-16));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(0, -16)),
        decipher.final(),
      ]),
    );
    assert.equal(payload.AccessPoint, 'https://backend.example/api/profile');
    assert.equal(payload.Timestamp, undefined);
    let body = { Encrypted: false, ...result };
    if (mode === 'encrypted') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
      const sealed = Buffer.concat([
        cipher.update(JSON.stringify(result)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      body = {
        Encrypted: true,
        IV: iv.toString('base64'),
        Payload: sealed.toString('base64'),
      };
    }
    return new Response(JSON.stringify(change(body)), { status: 200 });
  });
}
const send = (client) =>
  client.send({ accessPoint: 'https://backend.example/api/profile' });

for (const mode of ['encrypted', 'plain']) {
  for (const required of [true, false]) {
    test(`${mode} response with requireEncryptedResponse=${required}`, async (t) => {
      mockGateway(t, mode);
      const client = new GatewayClient(
        'https://gateway.example/api/gateway',
        pem,
        undefined,
        { requireEncryptedResponse: required },
      );
      if (mode === 'plain' && required) {
        await assert.rejects(send(client), /Encrypted response required/);
      } else {
        assert.deepEqual(await send(client), result);
      }
    });
  }
}
test('defaults to rejecting plaintext', async (t) => {
  mockGateway(t, 'plain');
  await assert.rejects(
    send(new GatewayClient('https://gateway.example', pem)),
    /Encrypted response required/,
  );
});
test('accepts the previous encrypted format without a marker', async (t) => {
  mockGateway(t, 'encrypted', ({ Encrypted, ...body }) => body);
  assert.deepEqual(
    await send(new GatewayClient('https://gateway.example', pem)),
    result,
  );
});
test('tampered ciphertext fails even when plain responses are permitted', async (t) => {
  mockGateway(t, 'encrypted', (body) => {
    const bytes = Buffer.from(body.Payload, 'base64');
    bytes[0] ^= 1;
    return { ...body, Payload: bytes.toString('base64') };
  });
  await assert.rejects(
    send(
      new GatewayClient('https://gateway.example', pem, undefined, {
        requireEncryptedResponse: false,
      }),
    ),
  );
});
for (const marker of ['false', 0, null, undefined]) {
  test(`rejects plaintext with invalid marker ${String(marker)}`, async (t) => {
    mockGateway(t, 'plain', (body) => ({ ...body, Encrypted: marker }));
    await assert.rejects(
      send(
        new GatewayClient('https://gateway.example', pem, undefined, {
          requireEncryptedResponse: false,
        }),
      ),
      /Invalid gateway response/,
    );
  });
}
test('rejects a malformed plaintext result', async (t) => {
  mockGateway(t, 'plain', () => ({ Encrypted: false, StatusCode: 200 }));
  await assert.rejects(
    send(
      new GatewayClient('https://gateway.example', pem, undefined, {
        requireEncryptedResponse: false,
      }),
    ),
    /Invalid gateway response/,
  );
});
test('requires an actual boolean client option', () => {
  assert.throws(
    () =>
      new GatewayClient('https://gateway.example', pem, undefined, {
        requireEncryptedResponse: 'false',
      }),
    /must be boolean/,
  );
});
