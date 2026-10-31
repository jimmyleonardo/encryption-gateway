# API specification

## `POST /api/gateway`

The `/api/v2/gateway` route is an identical alias supporting the exact same behavior and modes.

Plaintext payload structure before client-side encryption:

```json
{
  "Method": "POST",
  "AccessPoint": "https://api.example.com/api/login",
  "Header": [{ "Key": "Content-Type", "Value": "application/json" }],
  "Body": { "email": "user@example.com", "password": "secret" },
  "Parameter": { "locale": "en" }
}
```

`AccessPoint` is required. `Method` defaults to `GET`. `Header`, `Body`, and `Parameter` are optional. No `Timestamp` or `Nonce` is required; legacy fields are ignored. Identical requests can be safely forwarded to the upstream backend as long as they pass validation and rate limits.

The payload transmitted across the wire by the SDK:

```json
{
  "KeyId": "KEY_ID_FROM_SERVER",
  "EncryptedKey": "<base64: RSA-OAEP-SHA256 wrapped AES key>",
  "IV": "<base64: 12-byte IV>",
  "Payload": "<base64: AES-256-GCM ciphertext + 16-byte authentication tag>"
}
```

Values inside `<...>` represent format descriptions, not literal ciphertext. `KeyId` is optional for backwards compatibility, but recommended for clean key rotation.

## Encrypted Response (`ENCRYPT_RESPONSE=true`)

HTTP 200:

```json
{
  "Encrypted": true,
  "IV": "<base64: Fresh 12-byte IV>",
  "Payload": "<base64: AES-256-GCM encrypted backend response + 16-byte tag>"
}
```

After client SDK decryption:

```json
{
  "StatusCode": 200,
  "Headers": { "content-type": "application/json" },
  "Data": { "success": true }
}
```

The gateway reuses the request's AES session key combined with a fresh 12-byte random IV. Clients do not perform RSA decryption on responses.

## Standard Response (`ENCRYPT_RESPONSE=false`)

HTTP 200, without client-side decryption:

```json
{
  "Encrypted": false,
  "StatusCode": 200,
  "Headers": { "content-type": "application/json" },
  "Data": { "success": true }
}
```

The SDK normalizes both response formats into the exact same object structure. Standard responses remain wrapped in the `{ StatusCode, Headers, Data }` envelope; this is not a raw byte-for-byte stream proxy.

**Upstream status codes are exposed in `StatusCode`.** For example, if the backend returns 401: the gateway returns HTTP 200 with `StatusCode: 401` inside the payload across both encrypted and standard modes. Applications must inspect the SDK result's `statusCode`, rather than assuming HTTP 200 at the transport layer indicates application success. Upstream headers are sanitized; `Set-Cookie` can be an array inside the envelope.

## Gateway Errors

Gateway errors return standard non-200 HTTP statuses with plain JSON bodies in both modes. The SDK treats them as network/gateway errors rather than decrypted backend payloads.

| HTTP Status | Root Cause |
|---|---|
| 400 | Invalid request format, decryption failure, invalid headers, or rejected target/method |
| 400 + `UNKNOWN_KEY_ID` | Key ID unknown to gateway |
| 413 | Incoming JSON payload exceeds `MAX_BODY_SIZE` |
| 429 | Gateway rate limit exceeded |
| 502 | Backend unreachable or response exceeds maximum size |
| 504 | Backend upstream timeout |

## Utility Endpoints

- `GET /health`: Returns `{"status":"ok"}` for gateway process liveness.
- `GET /public-key`: Returns `keyId`, `pem`, `spkiBase64`, `pkcs1Base64`, `sha256Fingerprint`, `algorithm`, and `acceptedKeyIds`.

## Response Mode Selection

Configure a single environment variable in `.env`:

```env
# Default: both request and response are encrypted at the application layer.
ENCRYPT_RESPONSE=true
```

Or:

```env
# Request is encrypted; response is standard JSON over HTTPS.
ENCRYPT_RESPONSE=false
```

| Server Config | Client → Gateway Request | Gateway → Client Response | SDK Setting |
|---|---|---|---|
| `true` (or unset) | Encrypted | Encrypted | Default matches automatically |
| `false` | Encrypted | Standard JSON | Set `requireEncryptedResponse=false` during client initialization |

The SDK inspects the `Encrypted` flag in the response. If `true`, the SDK decrypts using the request's AES session key. If `false`, the SDK parses the payload directly **only if explicitly permitted by the client configuration**. A decryption failure is never silently converted into a plaintext read.

Setting `requireEncryptedResponse=false` allows **both formats**. This enables zero-downtime migrations from standard responses to encrypted responses without modifying application UI code. The SDK default is `true`, preventing server misconfigurations from inadvertently downgrading response protection.

After modifying `.env`, recreate the container to apply changes:

```bash
docker compose up -d --force-recreate gateway
```

A simple `docker compose restart` does not reload container environment variables. When transitioning to standard response mode, ensure updated clients supporting `requireEncryptedResponse=false` are released **before** setting the server to `false`. Mode configuration applies server-wide; client requests cannot override server policy. Values other than `true` or `false` (an empty value uses the default) cause process startup to fail.
