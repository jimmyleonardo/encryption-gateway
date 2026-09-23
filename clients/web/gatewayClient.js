// clients/web/gatewayClient.js — Zero dependencies: WebCrypto only (all modern browsers & Node 18+)

/** bytes -> base64 (chunked so large payloads don't overflow the stack) */
function toB64(bytes) {
  const arr = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export class GatewayError extends Error {
  constructor(status, body) {
    const msg = Array.isArray(body?.message)
      ? body.message.join(', ')
      : (body?.message ?? 'Gateway request failed');
    super(`Gateway ${status}: ${msg}`);
    this.status = status;
    this.code = body?.code; // e.g. UNKNOWN_KEY_ID
  }
}

export class GatewayClient {
  /**
   * @param {string} gatewayUrl e.g. https://gateway.example.com/api/gateway
   * @param {string} serverPublicPem gateway public key in PEM format
   * @param {string} [keyId] gateway KeyId (from GET /public-key)
   * @param {{requireEncryptedResponse?: boolean}} [options] Set false to accept both response modes.
   */
  constructor(
    gatewayUrl,
    serverPublicPem,
    keyId,
    { requireEncryptedResponse = true } = {},
  ) {
    if (typeof requireEncryptedResponse !== 'boolean')
      throw new TypeError('requireEncryptedResponse must be boolean');
    this.requireEncryptedResponse = requireEncryptedResponse;
    this.gatewayUrl = gatewayUrl;
    this.keyId = keyId;
    const der = fromB64(serverPublicPem.replace(/-----[^-]+-----|\s/g, ''));
    this.serverKey = crypto.subtle.importKey(
      'spki',
      der,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );
  }

  /**
   * Sends a request through the encryption gateway.
   * @param {Object} options
   * @param {string} [options.method='GET'] HTTP method (GET, POST, PUT, DELETE, etc.)
   * @param {string} options.accessPoint Destination full URL, e.g. https://api.mybackend.com/users
   * @param {Object} [options.headers={}] Request headers map
   * @param {any} [options.body] Request body (will be sent as JSON)
   * @param {Object|string} [options.parameter] Query parameters
   * @returns {Promise<{StatusCode: number, Headers: Object, Data: any}>}
   */
  async send({ method = 'GET', accessPoint, headers = {}, body, parameter }) {
    const payload = {
      Method: method,
      AccessPoint: accessPoint,
      Header: Object.entries(headers).map(([Key, Value]) => ({ Key, Value })),
      Body: body,
      Parameter: parameter,
    };

    // 1. Fresh AES-256 key + IV for this request
    const rawKey = randomBytes(32);
    const aesKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    const iv = randomBytes(12);

    // 2. AES-GCM seal the payload (WebCrypto appends the 16-byte tag)
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(JSON.stringify(payload)),
    );

    // 3. RSA-OAEP-SHA256 encrypt the AES key with the gateway public key
    const encryptedKey = await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      await this.serverKey,
      rawKey,
    );

    const res = await fetch(this.gatewayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        KeyId: this.keyId,
        EncryptedKey: toB64(encryptedKey),
        IV: toB64(iv),
        Payload: toB64(sealed),
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GatewayError(res.status, json);

    // Plain responses are accepted only when the application explicitly allows them.
    if (json?.Encrypted === false) {
      if (this.requireEncryptedResponse) {
        throw new Error(
          'Encrypted response required; check ENCRYPT_RESPONSE on the server',
        );
      }
      if ('IV' in json || 'Payload' in json)
        throw new Error('Invalid gateway response');
      return this.result(json);
    }
    // Missing marker is supported only for the legacy encrypted envelope.
    if (
      !json ||
      (json.Encrypted !== true && json.Encrypted !== undefined) ||
      typeof json.IV !== 'string' ||
      typeof json.Payload !== 'string'
    ) {
      throw new Error('Invalid gateway response');
    }

    // Decrypt with the request AES key; failed authentication never falls back to plain JSON.
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(json.IV) },
      aesKey,
      fromB64(json.Payload),
    );

    return this.result(JSON.parse(new TextDecoder().decode(plain)));
  }

  result(value) {
    if (
      !value ||
      !Number.isInteger(value.StatusCode) ||
      value.StatusCode < 100 ||
      value.StatusCode > 599 ||
      !value.Headers ||
      typeof value.Headers !== 'object' ||
      Array.isArray(value.Headers) ||
      !Object.hasOwn(value, 'Data')
    ) {
      throw new Error('Invalid gateway response');
    }
    return {
      StatusCode: value.StatusCode,
      Headers: value.Headers,
      Data: value.Data,
    };
  }
}
