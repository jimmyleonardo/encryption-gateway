# Live demo

A demo gateway runs on Vercel at **https://encryption-gateway.vercel.app**. It uses a demo-only key and forwards exclusively to the public mock API [JSONPlaceholder](https://jsonplaceholder.typicode.com) (`ALLOWED_ROUTES=jsonplaceholder.typicode.com/*`), so it cannot be used as an open proxy.

```bash
curl https://encryption-gateway.vercel.app/health
curl https://encryption-gateway.vercel.app/public-key
```

## Direct call vs. through the gateway

The same request, `POST {"userId":456}` to JSONPlaceholder, sent two ways.

**1. Direct, without the gateway**

```bash
curl -s -X POST \
  https://jsonplaceholder.typicode.com/posts \
  -H "Content-Type: application/json" \
  -d '{"userId":456}'
```

```json
{
  "userId": 456,
  "id": 101
}
```

The request body and the response are readable JSON. Anyone who can inspect the HTTPS traffic, for example with Burp Suite or Charles and a user-installed CA certificate on the device, sees exactly this.

**2. Through the gateway**

Run from a clone of this repository (Node.js 24+, no install needed):

```bash
GATEWAY_URL=https://encryption-gateway.vercel.app \
ACCESS_POINT=https://jsonplaceholder.typicode.com/posts \
node test-client.js
```

Output (ciphertext shortened):

```text
Plaintext payload: {
  "Method": "POST",
  "AccessPoint": "https://jsonplaceholder.typicode.com/posts",
  "Header": [],
  "Body": { "userId": 456 }
}

Encrypted request (sent over the wire): {
  "KeyId": "3502a2e31f6dc85b",
  "EncryptedKey": "aLOWv6Jn7n+KAkiReLrbvoZZ0TdWqBmnLAN9m9MzR80S…",
  "IV": "D9kbUGLDU2wwPG21",
  "Payload": "c9rG/ehyGMlieFQs3KTGfE97tOtp9S9SueAi7xKzCXPC…"
}

Gateway HTTP 200: {
  "Encrypted": true,
  "IV": "ZQTzaPlJIO91rjpd",
  "Payload": "evMAU+JlOqMTCHJTnndvZHtcAqeULidH+clQPsC/kRvV…"
}
Response mode: encrypted

Upstream HTTP status: 201
Upstream response: { "userId": 456, "id": 101 }
```

The first and last blocks exist only on the client. Everything in between is what an intercepting proxy would see: the target URL, the body and the response are all AES-256-GCM ciphertext. `IV` and `Payload` change on every run, even for identical data.

| | Direct | Through the gateway |
|---|---|---|
| Request on the wire | `{"userId":456}` | `{ KeyId, EncryptedKey, IV, Payload }` ciphertext |
| Response on the wire | `{"userId":456,"id":101}` | `{ Encrypted: true, IV, Payload }` ciphertext |
| Target URL visible in the body | Yes | No, it is inside the encrypted payload |
| Readable by a TLS-intercepting proxy | Yes | No |
| Result for the app | `{"userId":456,"id":101}` | `{"userId":456,"id":101}` (same) |

Both calls use HTTPS, so a passive eavesdropper on public Wi-Fi reads neither. The difference appears once TLS is intercepted on the device; see the [Threat Model](security.md#threat-model--defense-in-depth) for what payload encryption does and does not protect.

## The gateway rejects anything else

Plaintext requests are refused, so clients cannot skip encryption:

```bash
curl -s -X POST \
  https://encryption-gateway.vercel.app/api/gateway \
  -H "Content-Type: application/json" \
  -d '{"Method":"POST","AccessPoint":"https://jsonplaceholder.typicode.com/posts","Body":{"userId":456}}'
```

```json
{
  "message": [
    "property Method should not exist",
    "property AccessPoint should not exist",
    "property Body should not exist",
    "EncryptedKey must be base64 encoded",
    "IV must be base64 encoded",
    "Payload must be base64 encoded"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

Targets outside the allow-list are rejected before any upstream call, so the demo cannot be used as an open proxy:

```bash
GATEWAY_URL=https://encryption-gateway.vercel.app \
ACCESS_POINT=https://example.com/ \
node test-client.js
# Gateway HTTP 400: Target "POST example.com/" is not in the allowed list
```

The demo client fetches the public key from `/public-key` for convenience only; real apps must embed it (see [Key Management](configuration.md#key-management)). Rate limits on the demo are per serverless instance (see [Deploy to Vercel](deployment.md#deploy-to-vercel)).
