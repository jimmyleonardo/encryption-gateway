/**
 * Full-flow Gateway client (Node.js 18+).
 *   1. Get the server public key + KeyId (a real app EMBEDS these).
 *   2. Generate a random AES-256 key and IV for this request.
 *   3. AES-256-GCM encrypt the payload.
 *   4. RSA-OAEP-SHA256 encrypt the AES key with the server public key.
 *   5. POST { KeyId, EncryptedKey, IV, Payload } to /api/gateway.
 *   6. Read the response format; decrypt only when Encrypted=true.
 *
 * Local demo (after `node mock-upstream.js` + `npm run start:dev`):
 *   node test-client.js
 *
 * Against a deployed gateway:
 *   GATEWAY_URL=https://gateway.example.com \
 *   ACCESS_POINT=https://api.example.com/health \
 *   node test-client.js
 *
 * Env:
 *   GATEWAY_URL      gateway base URL            (default http://localhost:3000)
 *   ACCESS_POINT     URL the gateway forwards to (default mock-upstream)
 *   METHOD           HTTP method                 (default POST)
 *   BODY             JSON body                   (default {"userId":456})
 *   REQUIRE_ENCRYPTED_RESPONSE=false  allow plain responses (default true)
 *   AUTH_TOKEN       sent as "Authorization: Bearer <token>" (optional)
 *   SERVER_PUBLIC_KEY_PATH + KEY_ID  use these instead of GET /public-key
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const GATEWAY_URL = (
  process.env.GATEWAY_URL ?? 'http://localhost:3000'
).replace(/\/+$/, '');
const ACCESS_POINT =
  process.env.ACCESS_POINT ?? 'http://localhost:4000/api/getprofile';
const METHOD = process.env.METHOD ?? 'POST';
const BODY = JSON.parse(process.env.BODY ?? '{"userId":456}');

async function getServerKey() {
  if (process.env.SERVER_PUBLIC_KEY_PATH) {
    return {
      pem: fs.readFileSync(process.env.SERVER_PUBLIC_KEY_PATH, 'utf-8'),
      keyId: process.env.KEY_ID,
    };
  }
  // Fine for testing. A real app EMBEDS the key instead of fetching it.
  const res = await fetch(`${GATEWAY_URL}/public-key`);
  if (!res.ok) throw new Error(`GET /public-key → HTTP ${res.status}`);
  const info = await res.json();
  console.log(`Server key ${info.algorithm}, KeyId ${info.keyId}`);
  return info;
}

(async () => {
  const server = await getServerKey();

  // --- payload ---
  const payload = {
    Method: METHOD,
    AccessPoint: ACCESS_POINT,
    Header: process.env.AUTH_TOKEN
      ? [{ Key: 'Authorization', Value: `Bearer ${process.env.AUTH_TOKEN}` }]
      : [],
    Body: BODY,
  };
  console.log('Plaintext payload:', JSON.stringify(payload, null, 2));

  // --- encrypt: AES-256-GCM payload, RSA-OAEP-SHA256 key ---
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(), // ciphertext + 16-byte tag
  ]);
  const request = {
    KeyId: server.keyId,
    EncryptedKey: crypto
      .publicEncrypt(
        {
          key: server.pem,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        aesKey,
      )
      .toString('base64'),
    IV: iv.toString('base64'),
    Payload: sealed.toString('base64'),
  };
  console.log(
    '\nEncrypted request (sent over the wire):',
    JSON.stringify(request, null, 2),
  );

  const send = () =>
    fetch(`${GATEWAY_URL}/api/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

  // --- send ---
  const res = await send();
  const body = await res.json();
  console.log(`\nGateway HTTP ${res.status}:`, JSON.stringify(body, null, 2));
  if (res.status !== 200) {
    process.exitCode = 1;
    return;
  }

  let result;
  if (body.Encrypted === false) {
    if (process.env.REQUIRE_ENCRYPTED_RESPONSE !== 'false') {
      throw new Error(
        'Encrypted response required. To allow plain responses set REQUIRE_ENCRYPTED_RESPONSE=false',
      );
    }
    result = body;
  } else {
    if (body.Encrypted !== true && body.Encrypted !== undefined)
      throw new Error('Invalid response mode');
    const data = Buffer.from(body.Payload, 'base64');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      aesKey,
      Buffer.from(body.IV, 'base64'),
    );
    decipher.setAuthTag(data.subarray(data.length - 16));
    result = JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(0, data.length - 16)),
        decipher.final(),
      ]).toString('utf-8'),
    );
  }
  const { StatusCode, Headers, Data } = result;
  console.log(
    'Response mode:',
    body.Encrypted === false ? 'plain (HTTPS)' : 'encrypted',
  );
  console.log('\nUpstream HTTP status:', StatusCode);
  if (Headers) {
    console.log('Upstream Headers:', JSON.stringify(Headers, null, 2));
  }
  console.log('Upstream response:', JSON.stringify(Data, null, 2));
})().catch((err) => {
  console.error('❌', err.message);
  process.exitCode = 1;
});
