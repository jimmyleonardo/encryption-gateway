# Encryption Gateway

[![CI](https://github.com/jimmyleonardo/encryption-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/jimmyleonardo/encryption-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Vercel-000000?logo=vercel)](https://encryption-gateway.vercel.app/health)

Add application-layer encryption to an existing JSON API without adding decryption code to your backend.

```text
Android / iOS / Flutter / Web
          │ encrypted request
          ▼
   Encryption Gateway
          │ standard HTTP request over HTTPS
          ▼
     Your backend API
          │ standard response over HTTPS
          ▼
   Encryption Gateway
          │ encrypted response OR plain JSON over HTTPS
          ▼
       Client SDK → application data
```

**Client requests to the gateway are always encrypted.** The plain request examples below show the data before SDK encryption and what the gateway forwards to the backend. Sending that plain payload directly to `/api/gateway` returns HTTP 400.

Choose one response mode on the server:

| Server setting | Request to gateway | Response from gateway | Client setting |
| --- | --- | --- | --- |
| `ENCRYPT_RESPONSE=true` (default) | Encrypted | Encrypted | `requireEncryptedResponse=true` (default) |
| `ENCRYPT_RESPONSE=false` | Encrypted | Plain JSON envelope over HTTPS | `requireEncryptedResponse=false` |

The SDK returns backend status, headers, and data in both modes. Authentication and business rules stay in your backend. The gateway needs no database or Redis; its RSA identity key must persist across restarts.

## Contents

- [Run locally](#run-locally)
- [Integrate your backend](#integrate-your-backend)
- [Integrate your client](#integrate-your-client)
- [Deploy to production](#deploy-to-production)
- [Request and response examples](#request-and-response-examples)
- [Errors and troubleshooting](#errors-and-troubleshooting)
- [Key rotation and limits](#key-rotation-and-limits)
- [Development and documentation](#development-and-documentation)

## Run locally

Prerequisites: **Node.js 24+** and npm. For deployment with Docker, use Docker Engine and Docker Compose instead.

```bash
git clone https://github.com/jimmyleonardo/encryption-gateway.git
cd encryption-gateway
npm ci
cp .env.example .env
```

The example environment already permits `localhost:4000/api/*`. Run these commands in three separate terminals:

```bash
# Terminal 1: start the demo backend
node mock-upstream.js
```

```bash
# Terminal 2: start the gateway
npm run start:dev
```

```bash
# Terminal 3: send an encrypted request and print the decrypted result
node test-client.js
```

The gateway runs at `http://localhost:3000`. In development it generates a missing RSA key in `keys/private.pem`. Keep that file so the identity stays the same on restart.

```bash
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/public-key
```

The first command returns `{"status":"ok"}`. The second returns the public key formats and `keyId` your client needs.

To try plain **responses**, change `.env` to `ENCRYPT_RESPONSE=false`, restart the gateway, and run:

```bash
REQUIRE_ENCRYPTED_RESPONSE=false node test-client.js
```

Requests remain encrypted. The client now accepts either response format.

To print all five examples below without running a backend or opening network ports:

```bash
npm run examples
# Machine-readable output after the application has been built:
node scripts/show-examples.js --json
```

These examples use fictional upstream fixtures and a temporary key held only in memory. The local mock server used by `test-client.js` returns a simple profile; it does not implement the five fictional business APIs.

## Integrate your backend

Your backend keeps its existing endpoints, JSON bodies, authentication, and response codes. Integration requires three things:

1. Make the backend reachable from the gateway over HTTPS.
2. Allow the exact backend methods and paths in `.env`.
3. Have the client SDK send its target URL, method, headers, body, and query parameters through the gateway.

For the five examples in this README:

```env
ALLOWED_ROUTES=POST api.example.com/api/login,GET api.example.com/api/products,POST api.example.com/api/orders,PATCH api.example.com/api/profile,DELETE api.example.com/api/cart/items
ALLOW_HTTP_UPSTREAM=false
ENCRYPT_RESPONSE=true
```

You can allow a family of routes, such as `GET api.example.com/api/products/*`, when that matches your API. That prefix permits `/api/products/123`, but does not permit the root `/api/products`; add the root separately if needed.

`ALLOWED_TARGET_HOSTS` authorizes every supported method and path on a host. Its rules are combined with `ALLOWED_ROUTES` using OR semantics. Leave it empty when you want strict method/path restrictions.

The SDK encrypts this structure:

| Field | Required | Meaning |
| --- | --- | --- |
| `AccessPoint` | Yes | Full backend URL, including `https://` |
| `Method` | No | `GET` by default; supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `Header` | No | Backend headers, including `Authorization`; object map or array of `{Key, Value}` |
| `Body` | No | JSON value or legacy JSON string; sent for POST/PUT/PATCH/DELETE |
| `Parameter` | No | Query parameter object or legacy JSON string |

`Header.Authorization` becomes the backend authorization header. Host, framing, hop-by-hop, and proxy identity headers are filtered. GET bodies are omitted. Query parameters belong in `Parameter`; the URL can also contain a query string.

## Integrate your client

### 1. Bundle the gateway public key

After deploying, retrieve the public key from a trusted connection and distribute it with the application:

```bash
curl -fsS https://gateway.example.com/public-key > gateway-public-key.json
```

This JSON contains `pem` for Web/Android/Flutter, `pkcs1Base64` for iOS, and `keyId` for every SDK. Embed the public key in the client build. Store the **private** key only on the gateway. The demo client fetches the public key at runtime for local testing.

### Which keys must users replace?

Every deployment should generate its own RSA key pair. This repository includes **no deployment private key**, and the Flutter sample's `assets/gateway_public.pem` is an explicit placeholder. Do not use the public demo deployment's key for your own server.

| Value | Where it belongs | What the user configures |
| --- | --- | --- |
| RSA private key | Gateway server secret or protected key file | Generate a dedicated key; configure `RSA_PRIVATE_KEY` or `RSA_PRIVATE_KEY_PATH` |
| RSA public key | Client application resource | Copy the matching PEM; for iOS use `pkcs1Base64` from `/public-key` |
| `keyId` | Client configuration | Use the ID returned by the same gateway's `/public-key` endpoint |
| Gateway URL / backend origin | Client configuration and gateway allow-list | Replace example hosts with your deployment and backend |

Generate outside the repository:

```bash
npm run keygen -- --out ~/gateway-keys
```

Keep `~/gateway-keys/private.pem` only in server storage, mounted secrets, or your hosting platform's secret manager. Never copy it into Android, iOS, Flutter, Web, README examples, or inspector logs. The keygen command prints the private key's base64 representation for server setup; keep that output private too. Production requires an existing/configured key by default. See [key provisioning and rotation](docs/configuration.md#key-management).

The public key may be bundled or published; its authenticity matters. Obtain it from your trusted gateway over HTTPS and verify the fingerprint through your deployment configuration. A public key alone cannot decrypt these RSA-protected AES keys. Inspection helpers use the SDK's temporary per-request AES key internally to decode responses; they do not need the gateway private key.

For the Flutter sample, replace the placeholder with **only the public PEM**:

```bash
cp ~/gateway-keys/public.pem clients/flutter/example/assets/gateway_public.pem
```

If the gateway lives on another machine, use its matching `/public-key` output instead of generating an unrelated local pair. Changing only the app's public key will break decryption unless the corresponding private key is configured on that gateway.

### 2. Copy the SDK helper

| Platform | File to copy | Requirements |
| --- | --- | --- |
| Web / Node | [gatewayClient.js](clients/web/gatewayClient.js) | WebCrypto + Fetch; HTTPS or localhost in browsers |
| Android | [GatewayClient.kt](clients/android/GatewayClient.kt) | OkHttp + Kotlin Coroutines; adjust package namespace |
| iOS | [GatewayClient.swift](clients/ios/GatewayClient.swift) | CryptoKit + Security; iOS 15+ for the async URLSession helper |
| Flutter | [gateway_client.dart](clients/flutter/gateway_client.dart) | `pointycastle`, `basic_utils`, `http` |

Dependencies and full platform instructions: [Client SDK integration](docs/client-sdks.md).

### 3. Initialize once and send requests

In these examples, `publicKeyInfo` is the bundled contents of `gateway-public-key.json`. Native apps load the PEM/PKCS#1 value from their own bundled resources.

**Web / JavaScript**

```javascript
import { GatewayClient } from './gatewayClient.js';
import publicKeyInfo from './gateway-public-key.json' with { type: 'json' };

const gateway = new GatewayClient(
  'https://gateway.example.com/api/gateway',
  publicKeyInfo.pem,
  publicKeyInfo.keyId,
  { requireEncryptedResponse: true },
);

const result = await gateway.send({
  method: 'POST',
  accessPoint: 'https://api.example.com/api/login',
  headers: { 'Content-Type': 'application/json' },
  body: { email: 'budi@example.com', password: 'demo-password-only' },
});

if (result.StatusCode === 200) {
  console.log(result.Data.user);
} else {
  console.error(result.StatusCode, result.Data);
}
```

For browser apps, configure `CORS_ORIGINS=https://app.example.com` on the gateway. Your app/build tool must support JSON module imports; otherwise load the bundled JSON through its asset/config mechanism and pass the same `pem` and `keyId` fields.

**Android / Kotlin**

```kotlin
val gateway = GatewayClient(
    gatewayUrl = "https://gateway.example.com/api/gateway",
    serverPublicKeyPem = publicPem, // bundled PEM resource
    keyId = gatewayKeyId,
    requireEncryptedResponse = true,
)

// Call from a coroutine.
val result = gateway.send(
    method = "GET",
    accessPoint = "https://api.example.com/api/products",
    headers = mapOf("Authorization" to "Bearer $token"),
    parameter = JSONObject().put("page", 1).put("limit", 2),
)
val contentType = result.headers["content-type"]?.firstOrNull()
val cookies = result.headers["set-cookie"].orEmpty()
// Inspect result.statusCode and use result.data.
```

Android response headers use `Map<String, List<String>>` so repeated values are preserved. Older copies of this helper used string values; update consuming code when upgrading.

**iOS / Swift**

```swift
let gateway = try GatewayClient(
    gatewayURL: URL(string: "https://gateway.example.com/api/gateway")!,
    serverPublicKeyBase64: publicKeyPKCS1Base64, // bundled PKCS#1 key
    keyId: gatewayKeyId,
    requireEncryptedResponse: true
)

let result = try await gateway.send(
    method: "GET",
    accessPoint: "https://api.example.com/api/products",
    headers: ["Authorization": "Bearer \(token)"],
    parameter: ["page": 1, "limit": 2]
)
// Inspect result.statusCode and use result.data.
```

**Flutter / Dart**

```dart
final gateway = GatewayClient(
  gatewayUrl: Uri.parse('https://gateway.example.com/api/gateway'),
  serverPublicKeyPem: publicPem, // bundled PEM asset
  keyId: gatewayKeyId,
  requireEncryptedResponse: true,
);

final result = await gateway.send(
  method: 'GET',
  accessPoint: 'https://api.example.com/api/products',
  headers: {'Authorization': 'Bearer $token'},
  parameter: {'page': 1, 'limit': 2},
);
// Inspect result.statusCode and use result.data.
```

### Inspect plain requests and decrypted responses

Putting an inspector on the actual gateway transport displays the encrypted envelope. Use the logical client/helper below so capture happens **before request encryption and after response decryption**. The server can keep `ENCRYPT_RESPONSE=true`; Aegis Guardian is not required.

| Platform / inspector | Integration | Usage and sample |
| --- | --- | --- |
| Android / Chucker | Chucker before the final gateway application interceptor | [Complete OkHttp/Retrofit sample](docs/chucker.md) |
| iOS / Pulse | URLRequest adapter + manual Pulse recorder | [SwiftUI/UIKit console setup](docs/pulse.md) |
| Flutter / Samseer | `GatewaySamseerClient` records request and decoded result | [Guide](docs/samseer.md), [sample app](clients/flutter/example) |
| Flutter / Alice | `GatewayAliceClient` adds completed readable transactions | [Guide](docs/alice.md), same sample app with `INSPECTOR=alice` |

Other inspectors need an equivalent manual recorder or a client adapter that restores the backend response before the inspector sees it. Installing their interceptor only on the encrypted transport does not expose the plain body automatically.

These entries show the **logical backend transaction**: backend URL/method, application headers, request body, backend status, and decoded body. Enable plaintext inspectors in debug builds. Configure keys as described above; none of these integrations require a private key in the app.

### See plain requests and responses in Chucker

Android OkHttp/Retrofit apps can use [GatewayOkHttpInterceptor.kt](clients/android/GatewayOkHttpInterceptor.kt) alongside the SDK. Register application headers, then Chucker, then the gateway adapter as the last application interceptor. The adapter encrypts the outgoing request and restores the decrypted backend response before Chucker records it. Chucker shows the backend URL, method, plain JSON bodies, and backend status even with `ENCRYPT_RESPONSE=true`. Use a separate network transport for the gateway. [Complete Chucker integration guide](docs/chucker.md).

### See plain requests and responses in Pulse on iOS

iOS apps can use [GatewayHTTPClient.swift](clients/ios/GatewayHTTPClient.swift) and the debug-only [GatewayPulseRecorder.swift](clients/ios/GatewayPulseRecorder.swift). The adapter accepts an ordinary backend `URLRequest`, sends it through the encryption server, and records its plain body and decrypted response in Pulse. Open `PulseUI.ConsoleView` from your debug menu to inspect completed transactions. [Complete Pulse integration guide](docs/pulse.md).

### See plain requests and responses in Samseer on Flutter

Flutter apps can use [gateway_samseer_client.dart](clients/flutter/gateway_samseer_client.dart) around the existing SDK. It records the plain request before encryption and the decoded response with the backend status afterward. A [sample app](clients/flutter/example) includes login, product-list, and profile-validation actions plus an inspector button. [Complete Samseer integration guide](docs/samseer.md).

### See plain requests and responses in Alice on Flutter

Use [gateway_alice_client.dart](clients/flutter/gateway_alice_client.dart) instead of the Samseer wrapper. It records the original request and decoded response in Alice using the backend status. The sample supports both inspectors; choose one per run:

```bash
cd clients/flutter/example
sh prepare.sh
flutter create --platforms=android,ios --project-name=gateway_inspector_sample --no-overwrite --no-pub .
flutter pub get
# Replace assets/gateway_public.pem with your deployment's public key first.
flutter run \
  --dart-define=INSPECTOR=alice \
  --dart-define=GATEWAY_URL=https://gateway.example.com/api/gateway \
  --dart-define=BACKEND_ORIGIN=https://api.example.com \
  --dart-define=GATEWAY_KEY_ID=YOUR_KEY_ID
```

Use `INSPECTOR=samseer` for Samseer (the default). The sample pins Alice 1.2.0 and Samseer 0.5.0; see the [Alice compatibility notes and integration steps](docs/alice.md). Configure real URLs, matching public key/key ID, and backend routes before sending requests. The inspector buttons are available only in debug builds.

### 4. Handle backend status and gateway errors

**The outer gateway HTTP status is 200 for a successfully transported backend response, including backend errors.** Check `StatusCode` (Web) or `statusCode` (native SDKs) for the backend result. A backend 201, 401, 404, or 422 stays inside the envelope.

Gateway failures use outer HTTP 400/413/429/502/504, and the SDK throws instead of returning a backend result. In plain response mode, initialize the SDK with `requireEncryptedResponse=false`. The same `send()` calls and result handling then work for both modes. `Set-Cookie` values inside the envelope are data; browser cookies are not set automatically.

## Deploy to production

Use HTTPS between the client and gateway, and between the gateway and backend. Choose one of the following deployment paths.

### Docker Compose on a VPS

**1. Prepare the repository and environment.**

```bash
git clone https://github.com/jimmyleonardo/encryption-gateway.git
cd encryption-gateway
cp .env.example .env
```

Replace the demo environment values with your real backend:

```env
PORT=3000
ALLOWED_ROUTES=POST api.example.com/api/login,GET api.example.com/api/products,POST api.example.com/api/orders,PATCH api.example.com/api/profile,DELETE api.example.com/api/cart/items
ALLOWED_TARGET_HOSTS=
ALLOW_HTTP_UPSTREAM=false
ENCRYPT_RESPONSE=true

# Explicitly generate the first key in the persistent gateway-keys volume.
# Alternatively provision RSA_PRIVATE_KEY and set this to false.
AUTO_GENERATE_KEYS=true
RSA_PRIVATE_KEY=

# This example assumes exactly one reverse proxy and no direct public access.
TRUST_PROXY=1
CORS_ORIGINS=https://app.example.com
```

Compose sets `NODE_ENV=production`. Production startup requires an existing/configured key, or the explicit generation setting above. The container runs as a non-root user and stores generated keys in the persistent `gateway-keys` volume.

**2. Build, start, and check the process.**

```bash
docker compose up -d --build
docker compose logs --tail=50 gateway
curl -fsS http://127.0.0.1:3000/health
```

The Compose file binds the gateway to `127.0.0.1:3000`, ready for a reverse proxy running on the same host. The health response confirms the gateway process is alive; it does not probe your backend.

**3. Put an HTTPS reverse proxy in front.**

For Caddy installed on the host, point your domain to the VPS and configure:

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then reload Caddy using your host's service management. Configure `TRUST_PROXY` for your actual proxy topology. Your client URL becomes `https://gateway.example.com/api/gateway`.

**4. Verify HTTPS and distribute the public key.**

```bash
curl -fsS https://gateway.example.com/health
curl -fsS https://gateway.example.com/public-key > gateway-public-key.json
```

Bundle this public key with your apps, then test a real backend request using the embedded key:

```bash
# Save the PEM field from gateway-public-key.json as gateway-public.pem.
# Replace KEY_ID_FROM_SERVER with its keyId field.
GATEWAY_URL=https://gateway.example.com \
ACCESS_POINT=https://api.example.com/api/products \
METHOD=GET \
SERVER_PUBLIC_KEY_PATH=./gateway-public.pem \
KEY_ID=KEY_ID_FROM_SERVER \
node test-client.js
```

If the endpoint needs authentication, supply `AUTH_TOKEN` from your own login flow.

**5. Redeploy while retaining the identity key.**

```bash
# After source code updates
docker compose up -d --build

# After changing .env
docker compose up -d --force-recreate gateway
```

Compose loads container environment values when the container is created; restarting it does not apply an edited `.env`. See [Docker's environment configuration](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/) and the [deployment guide](docs/deployment.md).

Keep and back up `gateway-keys`. `docker compose down -v` removes the volume and its identity key. A newly generated key will break apps using the old public key.

### Node.js on a VPS or container platform

Use this when your host manages Node.js processes directly:

```bash
npm ci
npm run build
cp .env.example .env
npm run keygen
```

Edit `.env` with your HTTPS backend routes and set:

```env
RSA_PRIVATE_KEY_PATH=keys/private.pem
AUTO_GENERATE_KEYS=false
ALLOW_HTTP_UPSTREAM=false
ENCRYPT_RESPONSE=true
# Set ALLOWED_ROUTES to your real backend endpoints.
```

Start under your host's process manager with `NODE_ENV=production`:

```bash
NODE_ENV=production npm run start:prod
```

Use a persistent private key file or `RSA_PRIVATE_KEY` secret. Put an HTTPS reverse proxy in front, restrict direct public access to the Node port, and configure `TRUST_PROXY` for that proxy. Build the application before pruning development dependencies. `/health` is the liveness probe.

### Vercel or another ephemeral hosting platform

Vercel supports [NestJS with zero configuration](https://vercel.com/docs/frameworks/backend/nestjs) and recognizes this repository's `src/main.ts` entry point.

1. Run `npm ci`, then generate a dedicated deployment key outside the repository with `npm run keygen -- --out ~/gateway-keys-vercel`.
2. Copy the printed `RSA_PRIVATE_KEY=` base64 value into your hosting platform's secret settings. Keygen output contains the private key; keep its output private.
3. Import the repository and configure the environment values below before deploying.
4. Deploy, verify `/health` and `/public-key`, and bundle that public key with the clients.

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `RSA_PRIVATE_KEY` | Dedicated base64 PEM private key, stored as a secret |
| `AUTO_GENERATE_KEYS` | `false` |
| `ALLOWED_ROUTES` | Your real backend methods and paths |
| `ALLOW_HTTP_UPSTREAM` | `false` |
| `ENCRYPT_RESPONSE` | `true`, or `false` with explicitly permitted clients |
| `TRUST_PROXY` | The trusted proxy configuration for your hosting topology |
| `CORS_ORIGINS` | Your browser app origins, if applicable |

Use a stable environment secret for the RSA key: ephemeral filesystems and recycled instances cannot preserve generated keys. Keep production private keys scoped to production. If you need preview deployments, give them a separate key and test upstream; production keys must not be exposed to untrusted preview code. Rate limits count separately per instance. Hosting request/response and execution limits still apply. See [deployment details](docs/deployment.md).

## Request and response examples

The following **five complete examples** show different methods, larger nested responses, pagination, repeated headers, a backend validation error, and a DELETE body.

Read each example in this order:

1. **Plain request:** payload in client memory before encryption. The gateway decrypts this and constructs a normal backend request using `AccessPoint`, `Method`, `Header`, `Body`, and `Parameter`.
2. **Plain response:** gateway JSON when `ENCRYPT_RESPONSE=false`. `Data` is the backend response body; `StatusCode` and `Headers` describe the backend response.
3. **Encrypted request and response:** expand the block to see the actual complete base64 envelopes. The request format is the same in both response modes.
4. **Decrypted response:** the result your app receives from the Web SDK when `ENCRYPT_RESPONSE=true`. Plain mode returns the same normalized result, without the `Encrypted` marker.

All names, passwords, tokens, IDs, and backend response data are fictional. Ciphertext was generated and round-trip verified with the real Web SDK and gateway crypto/controller, using an in-memory demo key and mocked upstream responses. No live business backend was called. The published key ID and ciphertext belong to that discarded demo key; they are examples of the wire format, not requests to replay against your deployment. Run `npm run examples` to regenerate and verify fresh examples.

**Encryption format:** each SDK call creates a random 32-byte AES key and 12-byte request IV. `EncryptedKey` wraps the AES key with RSA-OAEP-SHA256. `Payload` contains AES-256-GCM ciphertext followed by its 16-byte authentication tag. The gateway encrypts the response with that request's AES key and a fresh IV. Ciphertext changes each run.

<!-- BEGIN GENERATED EXAMPLES: node scripts/show-examples.js -->


### 1. Login: user, permissions, and session (200)

A successful login returns user details and two Set-Cookie values. These cookies remain data in the envelope; browser cookie storage is not updated automatically.

**Plain request before SDK encryption (client memory / gateway-to-backend hop)**

```json
{
  "Method": "POST",
  "AccessPoint": "https://api.example.com/api/login",
  "Header": [
    {
      "Key": "Content-Type",
      "Value": "application/json"
    },
    {
      "Key": "X-App-Version",
      "Value": "1.4.0"
    }
  ],
  "Body": {
    "email": "budi@example.com",
    "password": "demo-password-only",
    "device": {
      "platform": "android",
      "appVersion": "1.4.0"
    }
  }
}
```

**Plain gateway response — `ENCRYPT_RESPONSE=false` (gateway HTTP 200)**

```json
{
  "Encrypted": false,
  "StatusCode": 200,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-login-001",
    "set-cookie": [
      "session=demo-session; Path=/; HttpOnly; Secure; SameSite=Lax",
      "locale=id-ID; Path=/; Secure; SameSite=Lax"
    ]
  },
  "Data": {
    "success": true,
    "message": "Login successful",
    "user": {
      "id": "usr_123",
      "name": "Budi Santoso",
      "email": "budi@example.com",
      "roles": [
        "customer"
      ],
      "permissions": [
        "profile:read",
        "orders:create",
        "orders:read"
      ],
      "profile": {
        "locale": "id-ID",
        "timezone": "Asia/Jakarta",
        "emailVerified": true
      }
    },
    "session": {
      "accessToken": "demo-access-token-not-a-real-jwt",
      "tokenType": "Bearer",
      "expiresIn": 3600,
      "refreshToken": "demo-refresh-token",
      "issuedAt": "2026-10-01T07:00:00Z"
    }
  }
}
```

<details>
<summary>Full encrypted request and encrypted response for this example</summary>

**Encrypted request — `POST /api/gateway`, `Content-Type: application/json`**

```json
{
  "KeyId": "8455ced1e33157ee",
  "EncryptedKey": "PJJeXK8gBg+OGjSgn+kqccyFJHUKCMIm4mMW5vLFkfIFnEvkBQD8wCyjaIiVJI2RygnxTvxt6CO28ATP4mne6u1EnNrOXyzW6hw+OCX/BlxP0vRObSHMnVTJ03oU+xSdbCuW7asyDV8SSDaNTMD2VJ9YK7y/v7SiPVbpsvkTG8yDjO+uhsy+X6k+4es7fP99sgXbZmMn1Q827TZmJNF9mDIIlNnkJOartmQV071CUOklLlrwQKQuCu52C0H7yByKTd8URxWYFNiIzCgpPQ1xDnK5nhVnCL3b4hRdeYoI1GWNHU+Uh/PRUxG7PGv41I2V4uJTmN5PzB1jlrftrWTpZQ==",
  "IV": "gI2wLT4wpWzRhh/s",
  "Payload": "cZBJw2t/0NVWH7FJ/8LSGEyxsaKbOwe7q2Jt3Poo458cIqakqpQ3TZVHBXuaN1Vw9MRGz7+xTLsY8v3el8oWOF9bV+qjdZSmsZNwts/oN98lHXOpVFKD/0ZBeS4e/8ay25i117eh4IyxNSuwHiao73extrRkdWIJ7bz8SjrC+ZM79UGYo45yUoKgD3ve/j1PTR/fVu5ayFhMwWFxPP/Y5Z+87Lx726tLCusSaxUrpLvyA6dBPDCqRgRlUpiAj875MBQvezqbE5+ebIHLuiYK3gWAszP3TJ5BZgyOjImYzDW4dXfz10O8KXBa9KmI4lJpY5I8/0RLKW77Il+a+3hNLt2VglNrKmCP+UdZcFbzUXzhmcVqrjGgVordqLeoCcPACXCl3lyk6wAYNWhFtbabQQE="
}
```

**Encrypted gateway response — `ENCRYPT_RESPONSE=true` (gateway HTTP 200)**

```json
{
  "Encrypted": true,
  "IV": "esuqRobZraRacyhG",
  "Payload": "scDD+8FP8cWYftqopURdM6GaNEnHP+xeYbEQ7Iff9w+SZP2rSslfCyi+p7nv7KVDjtiFH/OeXA6T/r+7PPaPGrkmi7pmf8yT71q5ZBznhG9/8pcr6h2acFcjzDtGkUgc/qkyQ714YRpGpzsa9BuIRu+5LNa4SUVVNi9AwBu2/9qwQy8A6P0R1l56J0TNJKyvyIPmpgyjYPCqjdAjMmhJ0e+m84dzVjUL77Tn0Hzw32HZuac2Ex57iEd3wJA4PJZe6p+sqqEKTQBmuM9/K3reTHF5VDRLlru0RZ5mrytIRRaWSsJWIhsKpqezMsWkBcV5Fmo9Yrpj4C9yPxGoq1Hmn5Mxgkt5mYdBuzS4wHnSzA05B5+Rfl3fF9sCe2cXTdI8TIPSislhbEwxJDj6fn7nnQyB50veAMp8brT6ZhGHN+1LsdM7n3w9NbTcerQ0awM2puiHqCD1AU0mE/AK/Ah4+hH3/0If7Eb75mpqEKVXFb4d7PvIkZfUqxFAhYuigd6h0HV0E7dtzTDYHAF5YJ2+KlwE8H+YE4ih22x9UgsT6g8WuCYOcH0VMWCawJoz0ZJGZWvcrbunl2Tu74ezm4mdFK1IW3FN3o2Q0fpGu7YXaUl0pyHEyiHS0G8jQfH01PfdRV1VCwyrk5tQjE8+sDDIyleIa06eUhDPSAD//LxTtQJdxmxoJMGCtPA69crwLekv8/YJzJ86P0oDPp6Ylm+1cayK5SrJrZSGhgGU6FhSDpByTHNuFqEzQz15XDm26jCsrbAuZzxQaou+4fcHX2IK3o3ImLxjVyzW6mnhawPFyw1o4aePevV1PjK7/N+Tdcs9d1koyuphGw5Kb8Kgahgf63gMpnyfs1lWbxdfrvxYrVgAKYPE/+KJOOPv4kWFzxYYUbsn7wHF4YKRV9Sz8EIFCPbRkEQ="
}
```

</details>

**Decrypted response returned by the Web SDK**

```json
{
  "StatusCode": 200,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-login-001",
    "set-cookie": [
      "session=demo-session; Path=/; HttpOnly; Secure; SameSite=Lax",
      "locale=id-ID; Path=/; Secure; SameSite=Lax"
    ]
  },
  "Data": {
    "success": true,
    "message": "Login successful",
    "user": {
      "id": "usr_123",
      "name": "Budi Santoso",
      "email": "budi@example.com",
      "roles": [
        "customer"
      ],
      "permissions": [
        "profile:read",
        "orders:create",
        "orders:read"
      ],
      "profile": {
        "locale": "id-ID",
        "timezone": "Asia/Jakarta",
        "emailVerified": true
      }
    },
    "session": {
      "accessToken": "demo-access-token-not-a-real-jwt",
      "tokenType": "Bearer",
      "expiresIn": 3600,
      "refreshToken": "demo-refresh-token",
      "issuedAt": "2026-10-01T07:00:00Z"
    }
  }
}
```

### 2. Product search: query parameters and pagination (200)

Parameter becomes the upstream query string. GET bodies are omitted. This example includes multiple products, nested variants, filters, and pagination.

**Plain request before SDK encryption (client memory / gateway-to-backend hop)**

```json
{
  "Method": "GET",
  "AccessPoint": "https://api.example.com/api/products",
  "Header": [
    {
      "Key": "Authorization",
      "Value": "Bearer demo-access-token-not-a-real-jwt"
    }
  ],
  "Parameter": {
    "page": 1,
    "limit": 2,
    "search": "coffee",
    "category": [
      "beans",
      "equipment"
    ],
    "sort": "price_asc"
  }
}
```

**Plain gateway response — `ENCRYPT_RESPONSE=false` (gateway HTTP 200)**

```json
{
  "Encrypted": false,
  "StatusCode": 200,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-products-002"
  },
  "Data": {
    "success": true,
    "items": [
      {
        "id": "prd_101",
        "name": "Gayo Arabica Coffee Beans",
        "category": "beans",
        "price": {
          "amount": 85000,
          "currency": "IDR"
        },
        "stock": 42,
        "rating": {
          "average": 4.8,
          "reviews": 127
        },
        "variants": [
          {
            "sku": "GAYO-250-WHOLE",
            "weightGrams": 250,
            "grind": "whole-bean",
            "available": true
          },
          {
            "sku": "GAYO-250-FILTER",
            "weightGrams": 250,
            "grind": "filter",
            "available": true
          }
        ]
      },
      {
        "id": "prd_205",
        "name": "Pour-over Coffee Dripper",
        "category": "equipment",
        "price": {
          "amount": 120000,
          "currency": "IDR"
        },
        "stock": 18,
        "rating": {
          "average": 4.6,
          "reviews": 83
        },
        "variants": [
          {
            "sku": "DRIPPER-02-WHITE",
            "color": "white",
            "available": true
          }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 2,
      "totalItems": 18,
      "totalPages": 9,
      "hasNextPage": true,
      "nextPage": 2
    },
    "filters": {
      "search": "coffee",
      "category": [
        "beans",
        "equipment"
      ],
      "sort": "price_asc"
    }
  }
}
```

<details>
<summary>Full encrypted request and encrypted response for this example</summary>

**Encrypted request — `POST /api/gateway`, `Content-Type: application/json`**

```json
{
  "KeyId": "8455ced1e33157ee",
  "EncryptedKey": "hXAL2zT8bY+EjIEUaVY8KUo6It4eWTU9GRK6s8sCqOONWDKgQcXxXNWAnMLJEFw0KtjIH0hwBYvHGOOKGAh3xHGcCAGh+snZ28xDGmNkHSSRzRKsKaFWs1FrXzwL5zH81WXPpS+4iO11RvDB7HowKlFvgwXjDUVlUnAGch8BB/p01xLlQGIZxfLB/65LacdmCw5qY/3wFE+f3ocrCEH0QEHy+wT5jnatDayh/ieZlM8hxEpZgZfhutkJZWQwre8iR42kUNzbLRbciUGs1NtUTGwn3gnYSgkUGZduLeT/ojHzCI4LiQYl3SZYclvfMQsT0PGFPqDP2R+8xpW8Llp5nQ==",
  "IV": "uDe3MuUaEWx1DYRp",
  "Payload": "fnafrohAYcYWhQREtwjP2ehQ2Tj3UDKkE3Ap/yog7UtM1yfTIqfXajOGUIk5SebcOG7NA5a7wTtyQAruHDaIQgNFXEmLGaFngb0Ji/KPAguoA1bZcKDa3sKHZ1MPgYLs9STZJDRff2dD98hevxkhIAV3MIhIvjRo8DjYxhkDDFmu+QAUWwaD/izkqC7gVBzcCK/HnxfBNIot+pDH4FvgFSIUfMRU3TLNCTSyWUpe4wTzTG+fiQFVkA1FoSDuQBGP8M+nCmMgYqu0MilzyUuo2zcaFWjVA0nfOt5a4I+jGZTPs7yQaG61wUCXTiu6dDnYYQcQ/74AuGsOIWXD/DMI5XT7L2S9z//cqCipHtacw8vQ"
}
```

**Encrypted gateway response — `ENCRYPT_RESPONSE=true` (gateway HTTP 200)**

```json
{
  "Encrypted": true,
  "IV": "LhaKD+0CccjdJzqF",
  "Payload": "aPSMMxKOIsuZ+klNxlfkvoa37GGJKbIB3JhSZU46ZUVx5zWdPxxUBqLKpEeTcJaFu/ByEDjP7A6L+l6+JQw+E7cvbAbdC0v0pIMX8NzFYW/Hlo2YNNH35Xn6r2HGBX5jguCzs0cUmw/d3mRCeJCTQFzXJsv2dhYrKsKirdQXCzzOayCDSblVVTOk1TqridwphjaG6L1t7MjUfe3V/tzD/a/ATuzbC9OKrRxh34JvRZNUj0uEGFEhxhrE/39EI5vlGEiaq3vOcZSkZMrtevbz2G0/IQAmKuRf8pZsVE2QBm3D5lvSH/Q9vb9rcGqFuGawhxBxeTCZDBO7JEevVbkErRNHASj4+mPI01VPk7OqL+2jmkNdrCHcCuDDHQQjdfPsqETdqECrjQ8CjMVhUaaTow9SSTZHazeoMPBloIDm6WJTxjzVwo2A0Ln2wypg5tgsJHBMlBsUlITFOtZoVGCWjmU+5Ichh5XVPhX6UZYJ3Uk7+O7koJgtcHDbZ3Yq/RacExL7Y8H70bd/uKYqxIkKb+BEaJwM4IxRQN3o4VmQjjhsBIXbQwYgRs5/npFh3BSPUrz87SPtUI2xKIA0PkKtzobO7z2KiltrewmfYxz1/OiQwi0yMSvpmLRq3RZkr/RL+/THmg6VzUugUSf/eJtE8a5Qls/mPLeZR6PxtxRTX7iWwkCHyylUzFLkn8nJP2LIJjkdw9A/7G7J/spwV7/ArkzwJV6hSr4nYFmOqT6G2oAvV0Ab9BlAFFFaPxeAOuXIwZYYsbNIw6gfVQ9JCX+a8voXO5qwHJyaEj/mOFvPmp7YvY35p9sQTANesRKeDxWazVd0uh7SeWgbWT21d4ePmM5L1B1nyzdyS2uJgv2UJ2P0a//0XDkBTmw/wvIPZJecuvnhBt8x9sxSiXiQxDHol/GQmAjf/PaIJl8VTz9m5xukaMjNyzpH+lHR6kFqMVQWfQkQtxJgikyQffW9Rylcp4hBnQz8f04StHPk3nO5zIvffucHMwOppHKkPeucxocqbN8s09/gBBEwcgOa06TLyWsOtDDmBZdaRsnax/Q9GExBfn3T00TZUQYJccwQYth8nTx0Gu5EC+qy6GGQfDJteWTCcD/38URpuHuPyZ7p8rWistN76lFy4/lfFigvyjChQ+Xs1A5OnWfOitkNrj41LhHbesHq6vmfpilBE4QOVmqV+pY8eBLVc0NT"
}
```

</details>

**Decrypted response returned by the Web SDK**

```json
{
  "StatusCode": 200,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-products-002"
  },
  "Data": {
    "success": true,
    "items": [
      {
        "id": "prd_101",
        "name": "Gayo Arabica Coffee Beans",
        "category": "beans",
        "price": {
          "amount": 85000,
          "currency": "IDR"
        },
        "stock": 42,
        "rating": {
          "average": 4.8,
          "reviews": 127
        },
        "variants": [
          {
            "sku": "GAYO-250-WHOLE",
            "weightGrams": 250,
            "grind": "whole-bean",
            "available": true
          },
          {
            "sku": "GAYO-250-FILTER",
            "weightGrams": 250,
            "grind": "filter",
            "available": true
          }
        ]
      },
      {
        "id": "prd_205",
        "name": "Pour-over Coffee Dripper",
        "category": "equipment",
        "price": {
          "amount": 120000,
          "currency": "IDR"
        },
        "stock": 18,
        "rating": {
          "average": 4.6,
          "reviews": 83
        },
        "variants": [
          {
            "sku": "DRIPPER-02-WHITE",
            "color": "white",
            "available": true
          }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 2,
      "totalItems": 18,
      "totalPages": 9,
      "hasNextPage": true,
      "nextPage": 2
    },
    "filters": {
      "search": "coffee",
      "category": [
        "beans",
        "equipment"
      ],
      "sort": "price_asc"
    }
  }
}
```

### 3. Create an order: nested body and idempotency key (201)

The gateway transports the Idempotency-Key header. The backend must implement idempotency. Gateway HTTP status is 200; the backend creation status is StatusCode: 201.

**Plain request before SDK encryption (client memory / gateway-to-backend hop)**

```json
{
  "Method": "POST",
  "AccessPoint": "https://api.example.com/api/orders",
  "Header": [
    {
      "Key": "Authorization",
      "Value": "Bearer demo-access-token-not-a-real-jwt"
    },
    {
      "Key": "Content-Type",
      "Value": "application/json"
    },
    {
      "Key": "Idempotency-Key",
      "Value": "demo-order-20261001-001"
    }
  ],
  "Body": {
    "items": [
      {
        "productId": "prd_101",
        "sku": "GAYO-250-WHOLE",
        "quantity": 2
      },
      {
        "productId": "prd_205",
        "sku": "DRIPPER-02-WHITE",
        "quantity": 1
      }
    ],
    "shippingAddress": {
      "recipient": "Budi Santoso",
      "phone": "+6281200000000",
      "street": "Jl. Contoh No. 10",
      "city": "Jakarta Selatan",
      "postalCode": "12345",
      "country": "ID"
    },
    "paymentMethod": "bank_transfer",
    "notes": "Please use recyclable packaging."
  }
}
```

**Plain gateway response — `ENCRYPT_RESPONSE=false` (gateway HTTP 200)**

```json
{
  "Encrypted": false,
  "StatusCode": 201,
  "Headers": {
    "content-type": "application/json",
    "location": "/api/orders/ord_9001",
    "x-request-id": "req-demo-order-003"
  },
  "Data": {
    "success": true,
    "message": "Order created",
    "order": {
      "id": "ord_9001",
      "number": "ORD-20261001-9001",
      "status": "awaiting_payment",
      "createdAt": "2026-10-01T07:05:00Z",
      "items": [
        {
          "productId": "prd_101",
          "name": "Gayo Arabica Coffee Beans",
          "quantity": 2,
          "unitPrice": 85000,
          "subtotal": 170000
        },
        {
          "productId": "prd_205",
          "name": "Pour-over Coffee Dripper",
          "quantity": 1,
          "unitPrice": 120000,
          "subtotal": 120000
        }
      ],
      "totals": {
        "currency": "IDR",
        "subtotal": 290000,
        "shipping": 15000,
        "discount": 10000,
        "grandTotal": 295000
      },
      "shipping": {
        "recipient": "Budi Santoso",
        "city": "Jakarta Selatan",
        "service": "standard",
        "estimatedDeliveryDays": {
          "min": 2,
          "max": 4
        }
      },
      "payment": {
        "method": "bank_transfer",
        "status": "pending",
        "reference": "PAY-DEMO-9001",
        "expiresAt": "2026-10-02T07:05:00Z"
      }
    }
  }
}
```

<details>
<summary>Full encrypted request and encrypted response for this example</summary>

**Encrypted request — `POST /api/gateway`, `Content-Type: application/json`**

```json
{
  "KeyId": "8455ced1e33157ee",
  "EncryptedKey": "gKC+IXypDMCr0sWGiOOGPdJeswR3x7C8RdAIJmYnujlr5M1SNysLObjj0QN8v34OqWZTvIlcPEr1M86zwXexv6u0urdmL8iBgAOx4x2xu+ZZIfgRms9K+gkO1P9/OIYmFMm0SO/p21q4Awv85Ps56I6J/6p4k0Dryel86JLT5lYuXh9qjcOwD44Z7RdL1mS5xpjCaLt/5SFZ/4K0MOaY/FoL4JLXdJSgfxyeiKxug4nBS+VUKDL07ss0GBohnuvdlaHR7CqymQ6y/KepPDl7shlDF/o2OrqoKcyG85fh+kbpbVppdQ79N/lo0oYflKFVjUqRYBSl0OutJx99WJE0Xg==",
  "IV": "ZOTEApTHPwoob3hj",
  "Payload": "+gGqZGKvnVBRifQ1chQifgNItM/4uXA5aQao+uyxWdPr4Dbm+AxpNYdTxlHUER2Z7lkNdBENVLDzls4FKR9t4lpbWX+6O48LSKeOLPN1oobA9N0XcUOsj7Mh7bva8KH2vvOrBXWzQ+t1W8pwSCrLp20HA83ojRFxhy4pvQfT9q37cR7+sk3bbjc4AZXPcrWD6cjKvn4s8yCGAIU+wewf7bJtf77/mKWAVUBpryybWo0MpQcqZCUwjiar4XIl1t/qtyDCpeCTZ7+HN/NRYfaqAjR0SSo1U1YrFw1gPJicB/HDwvkVxVdXalLoaoVzZqc2C+Dy1vKwCxCuqK5d42+QRLL+kv3eMJ04miejDRRlGsmAoSzHvepC61126Mn4AJ50AFjxcKJFDVnxrYWf+JQzAFClRX2URFWZ5D7JJJLUStxE0pjA2+ZnRZKliaiwChsiRgEOIXYQykGz7vvkp+1hmwbH7Pv7+sOaC9ViFWUg+rPsA1uWOkwwSdFxvCxmHuCDCLhH60yEkux9akyXHyezt2B2DKj8VF3A4fISBZzbWV+ofPnueTIm4IgxMn8urc3fN1gs/5Qy6VW+nls0seYzcS099nIa7nSLbTIndeODqKq+NRTDW3ymtUef7DuKxpi9rGhPvSWuxfOcLJRU3auQkMEHa/VyciWPzhRsJTLDxrrmsVmukBURu4y+CWBgocMDDsyx/V33HLbedldQvfbFeQ0bpj/cz0ZZY/bVLcp8XB2jo8+3ldAY0JZpbIbhfL+If31RlzefkB/tdElSNND0NuTejF6ZHyjS5a48ApuOLP6mk8YKKQIZ+NVYjohQGnCqkowwCxkEgEM2Oq8liPxrY1uyHbMg3PRsiZmGar34zX+r"
}
```

**Encrypted gateway response — `ENCRYPT_RESPONSE=true` (gateway HTTP 200)**

```json
{
  "Encrypted": true,
  "IV": "VAILwHkTfE+1+dOX",
  "Payload": "XKzZ/1ydDz6u7r8wNy98NhL0CGl/kAyyxxtIx+DaZOL9EAHa6EOE4XoMrl91tJMzoG0cBFoc7ieDfG+K3k4kjNueIH0siUFdWwsWYWJxN9fPKW87la98rPtpYsaY+cCSM61AhIsqbNPHvDaKAgd0ns/TuT0mlfU0C8iV/lzXoAsOQG90qGdP97m5I8XwBUBUK8x6oJLG4lVd1R466q3FvKUujcMs6vdUe1ICykpnFnuEVsN5P/kGwy3UU9tLMm8KFO1SysA7gpw4sZbEkrJdCxd+B7V+Kfdm/xd8eAm6m8jal94P9tMeAsSCjNcJFqSL4qtB17SOJaJmLLFI+cyZu3S1OUvlGzO2Zf/f60uH3+rDOScUupT/x37viudsMHBJiK0P1xYrJlpVBuMVFEeZwO1uvLeneNyvZXegnUpx+EwS8jU499SpMldjT5InXI9zDjoPaSMPjZ7+2ayGX9SjoIAsEg6QArjnwWfa/re2cAbQG2+4tgRYKMCfOPbsVze0kQFHcvGmCIsXZ+iVfDdLDylR2TSwAuZQdUrLVjDS1FJLpfirbrP7eSK/g9CIsp9D/BvtVDsoKiQG16JwKmApt601WyFxzoebcJ7glJEhJADcUBIviDnSA2et52pz7gYZOq2JS6oHDPcfDyWyhP8TbjsG4ZP8V33XV9bezSCOgl/P5xDO27OMyZ5gTjIiODao4tYztu2RY3g+8f55Zg35MG+J7xPBfC7qF7mTGF3Zo1zOoJXnWknleNctv40tlbEIC/nbVwqqs/Hwx9iq1p+3OdpdxbyuY3sEz3HGZNgcsr9h3hwP4O19ZopMLBNWybrClxXDEVZjRO4+/amtLfYrFynSfQXZMW/dflMCWacjqSk5/4SoqDrWHdLLdIrA7Ej729BfUD3aH64PMfTXdxaD7zY5uN8gEi4ggVz1L+tse68j95r1cK6eDpRhyv/fBrELCLA55YIr5Dp7slcbrb+BllaRUZlbeOFdXJx+vl/j6AzWLuUVINB+rx7uVeRHKE3x3Kq/kEREW1jpdI6G/fdls3eLL67dXZC94N7OCzkTTdvwHUYOrr1cPR/JKQKRQx5FbDxnThu7Lp2hATQCnPMTaiH21GribxE09t0aVyMV9cLSgFvlmz2ldZXyK5qdsrDvog6dqK49EPJnFM6xDieXA7WS/WBzVBpJLsLT"
}
```

</details>

**Decrypted response returned by the Web SDK**

```json
{
  "StatusCode": 201,
  "Headers": {
    "content-type": "application/json",
    "location": "/api/orders/ord_9001",
    "x-request-id": "req-demo-order-003"
  },
  "Data": {
    "success": true,
    "message": "Order created",
    "order": {
      "id": "ord_9001",
      "number": "ORD-20261001-9001",
      "status": "awaiting_payment",
      "createdAt": "2026-10-01T07:05:00Z",
      "items": [
        {
          "productId": "prd_101",
          "name": "Gayo Arabica Coffee Beans",
          "quantity": 2,
          "unitPrice": 85000,
          "subtotal": 170000
        },
        {
          "productId": "prd_205",
          "name": "Pour-over Coffee Dripper",
          "quantity": 1,
          "unitPrice": 120000,
          "subtotal": 120000
        }
      ],
      "totals": {
        "currency": "IDR",
        "subtotal": 290000,
        "shipping": 15000,
        "discount": 10000,
        "grandTotal": 295000
      },
      "shipping": {
        "recipient": "Budi Santoso",
        "city": "Jakarta Selatan",
        "service": "standard",
        "estimatedDeliveryDays": {
          "min": 2,
          "max": 4
        }
      },
      "payment": {
        "method": "bank_transfer",
        "status": "pending",
        "reference": "PAY-DEMO-9001",
        "expiresAt": "2026-10-02T07:05:00Z"
      }
    }
  }
}
```

### 4. Update a profile: backend validation errors (422)

Business errors are encrypted in encrypted-response mode too. The SDK returns this result; inspect StatusCode to distinguish it from a gateway transport error.

**Plain request before SDK encryption (client memory / gateway-to-backend hop)**

```json
{
  "Method": "PATCH",
  "AccessPoint": "https://api.example.com/api/profile",
  "Header": [
    {
      "Key": "Authorization",
      "Value": "Bearer demo-access-token-not-a-real-jwt"
    },
    {
      "Key": "Content-Type",
      "Value": "application/json"
    }
  ],
  "Body": {
    "name": "",
    "email": "invalid-email",
    "phone": "abc"
  }
}
```

**Plain gateway response — `ENCRYPT_RESPONSE=false` (gateway HTTP 200)**

```json
{
  "Encrypted": false,
  "StatusCode": 422,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-validation-004"
  },
  "Data": {
    "success": false,
    "error": {
      "code": "VALIDATION_FAILED",
      "message": "Please correct the highlighted fields",
      "fields": [
        {
          "field": "name",
          "code": "REQUIRED",
          "message": "Name must not be empty"
        },
        {
          "field": "email",
          "code": "INVALID_FORMAT",
          "message": "Email must be a valid email address"
        },
        {
          "field": "phone",
          "code": "INVALID_FORMAT",
          "message": "Phone must use international format, for example +6281200000000"
        }
      ]
    },
    "meta": {
      "requestId": "req-demo-validation-004",
      "retryable": false,
      "submittedAt": "2026-10-01T07:10:00Z"
    }
  }
}
```

<details>
<summary>Full encrypted request and encrypted response for this example</summary>

**Encrypted request — `POST /api/gateway`, `Content-Type: application/json`**

```json
{
  "KeyId": "8455ced1e33157ee",
  "EncryptedKey": "lIDzU1FHCLBQQoIveSQkxRzw0MGkimmDasZq6E7gxqVP8vCVwd7sXnS13Ans77cVXoQvewqkLorbSByYQYeSXwdHS6TQajUZB0mvTQfuOVrH/ZifNYbNVLiJlYLCW82Z20Q5JUlctstHR9hD+/fwsrth5ZX+++wUCy4yhXb6i+xln7bX3SaPFvV1C5L23W71Xlc3S3BvjJgrqB1ZfzeDViK9Rx7eutwcAlPWNumTbT3lMqgYIztH7W6/TTXdVVweiuQgsJxvRjNsuShG2bsabGAZrLQ8uZeu0jKHaJMBVWuQNArcWX4kB9qCeO1/K5l3cCJ2+z/Tsf1qsuRs6ThH5w==",
  "IV": "GqcUm408U1zD1bJm",
  "Payload": "sp7SJsltIhjHp6NgKnNcUANN3dWleO+QNmGQRXJ5zwEQf/Yqjr0KnGwt/K4zfzRHhSZMW3nU+Xpmonh1opAvFQQYp9RmAMY2cYRHs4TWjSDkT910on5LYixdCv6ZNOg1XSGI/MChxIBb+akwTNK7+YJzTJ5s3olVe89BoCPHqT70ZyRA5Zf5rtCDadrkq1tzOw/mZw+ZtQqbok0xM5fSWB9uN5EbGKEx+Chuv9gzr6dLFfa3IhA/hXQnui3n3x0dWKwK60e0xwlpxU58vTsPLhaGs+0HMFp2jajcd55ihc5EeSWyYvztZdI5UyHfP/8FvESujd3vLWp8HAz6KTdcTfV1J6NMYzwema69ozNxckA4hMbcHII="
}
```

**Encrypted gateway response — `ENCRYPT_RESPONSE=true` (gateway HTTP 200)**

```json
{
  "Encrypted": true,
  "IV": "yECAfylxhflWBzw+",
  "Payload": "2YqZrlerbAmxrMJdwBHIsWgp7EH2ukYWlrDgLL3D3P0tM4l41q3/N4oNcvkIUnBDEdIxvJr1h5U3V17cQdY4QR89x1/ybb7uKMoTTiifVi9aTPDsvW5pouWaZz9/LFjMfcybpKfpqSaDNOxNRo0fCCfHzw7W4+nWGaE+9pIgPB9FKl3ZEFqnDo9i/wD72il3pjBY/96DPuOJSOQU+2gXAuKQutyzL3clxh0dPFMql/w3FoY7xDTd46mbAgLZWmThJ/en8yG+AvqDnWQktB1BiBC4gLIMEIQRxW7zZZ9o7oOPmmk3Rw31Sb6Xcy4LylBbSFSUcEtTxlWpIMC5QVzxTWCr/6jEFkOtqQGnpyA09UfBrwsYWOvWMciETKthyvsWIqUKv4YO6zs0jvPDGlNoxuGlREkLIC1xY90wMEmcuM8gwZP2jhNuxHrHfSqAWARUdK2hiV6/BYJNBZSe5FIz4Bz46VxNes5M0NcP6CZg8KLowx9fDFTrIGo3IbJNvus+WlPu2rOc8T4BEwcrzGS01DIggqnRcIe26yRsA1ryjgTBekjLB85QfE99Rx3mM0DBEXelKOTqxmBujpF/j/VwiUtIgFC1JAsj4ofrDqT+6/ym5s7L8EDyld7ln0RT92RHXk8rL7O6QY283umOUBqvk99PSW/5NF99+ow44L63CNjYMAlo5g8vhKnfpcw1Z4glTx5U3VtgkC9KjElU0HHHl2RzJmZl2494McLuyvslSlyUsI2886R7MYP4y2IOzp8j/rmu8KJR9/IHL9sW/sx4/s+FK/KEyI48ITIYEQPQyyiHAwpAtJomFnRHRWU2duXA"
}
```

</details>

**Decrypted response returned by the Web SDK**

```json
{
  "StatusCode": 422,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-validation-004"
  },
  "Data": {
    "success": false,
    "error": {
      "code": "VALIDATION_FAILED",
      "message": "Please correct the highlighted fields",
      "fields": [
        {
          "field": "name",
          "code": "REQUIRED",
          "message": "Name must not be empty"
        },
        {
          "field": "email",
          "code": "INVALID_FORMAT",
          "message": "Email must be a valid email address"
        },
        {
          "field": "phone",
          "code": "INVALID_FORMAT",
          "message": "Phone must use international format, for example +6281200000000"
        }
      ]
    },
    "meta": {
      "requestId": "req-demo-validation-004",
      "retryable": false,
      "submittedAt": "2026-10-01T07:10:00Z"
    }
  }
}
```

### 5. Delete cart items: DELETE with a JSON body (200)

DELETE bodies are forwarded. Partial business results remain intact: the backend can report removed, missing, and remaining items in one response.

**Plain request before SDK encryption (client memory / gateway-to-backend hop)**

```json
{
  "Method": "DELETE",
  "AccessPoint": "https://api.example.com/api/cart/items",
  "Header": [
    {
      "Key": "Authorization",
      "Value": "Bearer demo-access-token-not-a-real-jwt"
    },
    {
      "Key": "Content-Type",
      "Value": "application/json"
    }
  ],
  "Body": {
    "itemIds": [
      "cart_101",
      "cart_205",
      "cart_missing"
    ],
    "reason": "customer_removed"
  }
}
```

**Plain gateway response — `ENCRYPT_RESPONSE=false` (gateway HTTP 200)**

```json
{
  "Encrypted": false,
  "StatusCode": 200,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-delete-005"
  },
  "Data": {
    "success": true,
    "message": "Cart updated",
    "removed": [
      {
        "id": "cart_101",
        "productId": "prd_101",
        "quantity": 2
      },
      {
        "id": "cart_205",
        "productId": "prd_205",
        "quantity": 1
      }
    ],
    "notFound": [
      "cart_missing"
    ],
    "cart": {
      "id": "cart_budi",
      "remainingItems": [
        {
          "id": "cart_333",
          "productId": "prd_333",
          "name": "Paper Coffee Filters",
          "quantity": 1,
          "unitPrice": 35000,
          "subtotal": 35000
        }
      ],
      "totals": {
        "currency": "IDR",
        "itemCount": 1,
        "subtotal": 35000
      },
      "updatedAt": "2026-10-01T07:15:00Z"
    }
  }
}
```

<details>
<summary>Full encrypted request and encrypted response for this example</summary>

**Encrypted request — `POST /api/gateway`, `Content-Type: application/json`**

```json
{
  "KeyId": "8455ced1e33157ee",
  "EncryptedKey": "MKtcBVeVQx25LUrgH8w3sGi5objjXipc9R+h9FedhFa97gnyMGKxZ1YVH13M0043rRddz73kdhPPvuO00Y/BEut/xmN4aRsugL6ROJ4GMHOkB7QWi4QhJdv4VrrkIXIsXsK+Kh3QfCoZE+2XIoIGRf89GJ8XfJDM/tpAnwBcRwtlRvQ9VybMpVZp5i+vWCnAQlNglHezqnroFBZpa5omLFI6p8gpAJFjzyK707a3ZFOW68B24kGzKJa3nUkryx48h6CEH2eOcMjZyBW4ZGR1EvM2mgmSqTYag4tYtGPMhuTnleKGkCUKv7FYTLN78KaQPwJk7njH5GtVBvGYineMnA==",
  "IV": "N2qlseN5kx3VzVmq",
  "Payload": "OhsJRCSKgoY02PHtYb+/prDVragvDY4bw7lnETJ6SjiA1R7CD9OCeMN0LjtoUIwg3F7dqIgMCtZlkUlB1p8RM9t4ZSzMGBIr/mgp8n3zP43ewmcao+PwbJ8U3XRd4zLBDPTnSVHoQFIQWtEQtw63yhnH4ehq1Sf7VZt873s5Go5RAfE2vpU5e1Y/IsXORHeSb7OJ3Cz9vKw3xkTZJVIIhyjwmOD0ishfK2VLT2KeaX4NAV/WTNFQ2LaAoFfqupgJo7JaoFoBzXDYHXUDfTiUeO4IpPnZAfvg8NxqijofPEWQXdpWm6bWnvBAkF2fOYQRb1X/7GhpsvGJvLu0DllDfSCtBsUwKfILVP8vO5l9Eb01fhQXB5af/xTuKWTj8GiXx7L7+LvFd2QwzXJtiEZsK6Ssb06A3/8="
}
```

**Encrypted gateway response — `ENCRYPT_RESPONSE=true` (gateway HTTP 200)**

```json
{
  "Encrypted": true,
  "IV": "4bFfU9zjIBTJdXqd",
  "Payload": "Vh0b+iMCIXEfyFHAtphAej90prGUaWH91U29t+2T72yzApTpl885Aqakgn1Sf3SbzYjG/C7VjS7kbjHQQ1VEU/Yfiy/VAzZx7NcgQFpWVxLhYYC5wkyPOhgV+dxAWhXDwTfGTGro4srM6USnOXe1SAstGIkxHlNEp6sI2AHf4sxuRalXHvJ7IvjMTvM0NktcJa8GWpRTiixvrSMixrwhXsj4JsOyPXpWU4j3RXkHrkK5HAuOIF2VFMgLPnbU8b0Mtk3QWrtoeQbNSInHUJ1zCEzAMdPGphbGM2KixeGYtO2bFvL2xH2hQ6AtdJgv4+B4A29iEg6+c8zHglLgZOz4a6+KT1GxJz5SE3sjBremV9orpZ7fYN1DccrADBJnQ2Qs5oiK8f2iEHBGeuMqGQFvcGNrJ+LBf8rYUxawqHkueB/ulCMjni1yDDdx1E9tLERGD4mI7pjO+ihHoOhEpIjkL5K6mBIdM6bbdZxIPKTr7orFlmZ6arXjQuraLwsJB6C6pu2GTT4bBs5zbCtnwSgfLAAeKnMTGZuKx+c3Mf9itNKYXOD+MMFg7UIbOjdsSqCxPWkVP4FfucbzS3tFc6QKO7m3pxbDsB5QU5Xw2fwFXnCU09sycWO546icwaHHfxttHjPwuhuelW0I5gdVhwqwROnkvgPTqAv1pTjaj7T/bS2nMQbAzM8/9PTnDX7OkV5t90OJx9kFOmu1bluc6mJTgVofK7ttE2jSMo/nC2bcebq19qXVS/kCd84="
}
```

</details>

**Decrypted response returned by the Web SDK**

```json
{
  "StatusCode": 200,
  "Headers": {
    "content-type": "application/json",
    "x-request-id": "req-demo-delete-005"
  },
  "Data": {
    "success": true,
    "message": "Cart updated",
    "removed": [
      {
        "id": "cart_101",
        "productId": "prd_101",
        "quantity": 2
      },
      {
        "id": "cart_205",
        "productId": "prd_205",
        "quantity": 1
      }
    ],
    "notFound": [
      "cart_missing"
    ],
    "cart": {
      "id": "cart_budi",
      "remainingItems": [
        {
          "id": "cart_333",
          "productId": "prd_333",
          "name": "Paper Coffee Filters",
          "quantity": 1,
          "unitPrice": 35000,
          "subtotal": 35000
        }
      ],
      "totals": {
        "currency": "IDR",
        "itemCount": 1,
        "subtotal": 35000
      },
      "updatedAt": "2026-10-01T07:15:00Z"
    }
  }
}
```


<!-- END GENERATED EXAMPLES -->

## Errors and troubleshooting

| Symptom | Meaning | What to check |
| --- | --- | --- |
| Gateway HTTP 400 | Invalid envelope/payload, failed decryption, or rejected route | SDK configuration, public key, `KeyId`, and `ALLOWED_ROUTES` |
| `UNKNOWN_KEY_ID` | Client key ID is not accepted | Keep the old key during migration, or update the client |
| Gateway HTTP 413 | Outer JSON request exceeds the body limit | `MAX_BODY_SIZE`; encryption/base64 adds overhead |
| Gateway HTTP 429 | Per-IP request limit exceeded | Respect `Retry-After`; verify `TRUST_PROXY` |
| Gateway HTTP 502 | Backend unreachable or response exceeds size limit | Gateway connectivity, TLS, backend logs, `MAX_UPSTREAM_RESPONSE_BYTES` |
| Gateway HTTP 504 | Backend request timed out | Backend latency and `UPSTREAM_TIMEOUT_MS` |
| HTTP 200 with `StatusCode: 401` or `422` | Backend authentication or validation failed | Inspect `Data`; this is a successfully transported business error |
| `Encrypted response required` | Client requires encryption, server returned plain JSON | Enable server encryption or deliberately allow both formats on the client |
| `No server key configured` during production startup | Key missing and generation not enabled | Provision a stable key; for persistent Docker storage only, opt into generation |
| Browser CORS failure | App origin not permitted | Set `CORS_ORIGINS` to the exact origin and restart/recreate the gateway |

Gateway errors are plain JSON with a non-200 outer HTTP status in both response modes. A rejected plain request, for example, looks like:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": [
    "property AccessPoint should not exist",
    "EncryptedKey must be base64 encoded",
    "IV must be base64 encoded",
    "Payload must be base64 encoded"
  ]
}
```

The SDK does not fall back to plaintext when ciphertext authentication fails.

## Key rotation and limits

For planned key rotation:

1. Generate the new pair outside the repository with `npm run keygen -- --out ~/gateway-keys-next`.
2. Configure `RSA_PRIVATE_KEY=<new_base64_key>,<old_base64_key>` and redeploy.
3. Release clients with the new public key and `KeyId`.
4. Remove the old key after clients migrate. Compromised keys require revocation according to your security policy.

| Setting | Default | Scope |
| --- | --- | --- |
| `MAX_BODY_SIZE` | `1mb` | Outer JSON request, including base64 overhead |
| `MAX_UPSTREAM_RESPONSE_BYTES` | `5242880` (5 MiB) | Upstream response after decompression |
| `UPSTREAM_TIMEOUT_MS` | `15000` | Backend request timeout |
| `THROTTLE_LIMIT` / `THROTTLE_TTL_MS` | 60 requests / 60000 ms | Per client IP, per gateway process |
| `THROTTLE_MAX_ENTRIES` | `10000` | Maximum in-memory IP counters |
| `AUTO_GENERATE_KEYS` | Disabled in production/tests; enabled otherwise | Missing-key creation; exact `true`/`false` overrides |

Body nesting is limited to 32 levels, including legacy JSON strings. Header names are limited to 256 characters and values to 8192 characters in all supported header shapes. See [configuration](docs/configuration.md) for the full environment reference.

Payload encryption complements HTTPS. Anyone with the public key can construct requests, so the backend must authenticate and authorize them. Replay prevention and idempotency belong in the backend. The gateway supports JSON/text APIs; streaming, arbitrary binary transport, multipart uploads, and WebSockets are outside its scope. Rate limiting is per process, and host allowlisting does not pin DNS answers. Deployment network controls and the full [security model](docs/security.md) describe these boundaries.

## Development and documentation

```bash
npm run lint:check
npm run build
npm test -- --runInBand
npm run test:clients
npm run test:e2e -- --runInBand
npm run examples
```

Unit tests cover crypto, payload limits, key-generation policy, route checks, controllers, and rate limits. E2E tests use the real gateway and a local upstream in default, encrypted, and plain response modes; they need permission to bind local ports. Web SDK tests cover response normalization, encrypted-response requirements, and tampered ciphertext. Validate native SDKs in your Android/iOS/Flutter application projects before shipping.

| Topic | Guide |
| --- | --- |
| All platform integration examples | [Client SDK integration](docs/client-sdks.md) |
| HTTP API, envelopes, and errors | [API specification](docs/api.md) |
| Docker, reverse proxy, and Vercel | [Deployment](docs/deployment.md) |
| Environment variables and key management | [Configuration](docs/configuration.md) |
| Threat model and limitations | [Security](docs/security.md) |
| Hosted demo and direct-versus-gateway comparison | [Live demo](docs/live-demo.md) |
| Quick-start guide | [Tutorial](docs/tutorial.md) |
| Architecture diagram | [Gateway flow](docs/images/gateway-flow.svg) |

## License

[Apache License 2.0](LICENSE). Copyright 2026 Jimmy Leonardo.
