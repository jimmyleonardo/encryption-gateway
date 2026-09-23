# Encryption Gateway

[![CI](https://github.com/jimmyleonardo/encryption-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/jimmyleonardo/encryption-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Vercel-000000?logo=vercel)](https://encryption-gateway.vercel.app/health)

A stateless NestJS gateway that adds application-layer encryption between **Android / iOS / Flutter / Web** clients and your backend API: **Client → Encryption Gateway → Backend API**.

**Requests are always encrypted by the client.** The gateway decrypts incoming requests and forwards them as standard HTTP requests to your upstream backend services. For responses, choose your preferred mode: the gateway can encrypt responses with authenticated AES-GCM or return standard JSON. The client SDKs abstract this completely, allowing your application logic to remain identical across both modes.

Both network hops use **HTTPS in production**. "Standard response" means without additional application-layer payload encryption; transport connections remain TLS-protected.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Client SDKs](#client-sdks)
- [Documentation](#documentation)
- [Testing](#testing)

## How it works

![Request is always encrypted; response supports encrypted or standard JSON](docs/images/gateway-flow.svg)

[View full-size SVG](docs/images/gateway-flow.svg) · [Download PNG](docs/images/gateway-flow.png).

## How It Works

**Request Flow — identical across both modes:**

1. The client constructs a request containing target backend URL, HTTP method, headers, query parameters, and body.
2. The SDK generates a cryptographically secure random 32-byte AES key and 12-byte IV, then encrypts the payload using **AES-256-GCM**.
3. The SDK encapsulates the AES key using **RSA-OAEP-SHA256** and the gateway's public key.
4. The gateway unwraps the AES session key, decrypts the payload, validates the request, and verifies the target against the route whitelist.
5. The gateway forwards the plaintext request over HTTPS to the backend API. The backend requires zero decryption code.

**Response Flow — depends on server configuration:**

- `ENCRYPT_RESPONSE=true`: Backend → plain response → Gateway **encrypts** → Client **decrypts via SDK** → application receives result.
- `ENCRYPT_RESPONSE=false`: Backend → plain response → Gateway → Client **reads JSON via SDK directly** → application receives result.

All supported platforms follow this exact lifecycle. The gateway is completely **stateless**: it does not persist requests, responses, or nonces, and requires no Redis, SQLite, or database dependencies. Authentication, authorization, replay prevention, idempotency, and business rules remain the responsibility of the backend. The RSA key pair must remain persistent across restarts; it represents the gateway's identity, not transaction state.

## Quick start

Try the hosted demo without installing anything:

```bash
curl https://encryption-gateway.vercel.app/health
curl https://encryption-gateway.vercel.app/public-key
```

It uses a demo-only key and forwards only to a public mock API. See the [live demo](docs/live-demo.md) for a direct-versus-gateway comparison.

To run it locally:

Prerequisites: **Node.js 24+**. Plain HTTP upstream is used strictly for local development.

```bash
npm install
cp .env.example .env
```

`.env.example` pre-authorizes the demo backend at `localhost:4000/api/*`. Run across three terminal windows:

```bash
# Terminal 1: Mock backend service
node mock-upstream.js

# Terminal 2: Encryption Gateway
npm run start:dev

# Terminal 3: Client that encrypts, sends, and verifies output
node test-client.js
```

To test standard response mode:

1. Update `.env` to `ENCRYPT_RESPONSE=false`.
2. Restart the gateway process.
3. Run the client with permission to accept standard responses:

```bash
REQUIRE_ENCRYPTED_RESPONSE=false node test-client.js
```

The test simulator displays response mode, backend status, filtered headers, and payload data. Fetching the public key automatically from `/public-key` in the demo client is strictly for local testing. Production mobile and web applications must embed the public key distributed securely by the backend team.

## Client SDKs

| Platform | SDK helper | Dependencies |
|---|---|---|
| Android | [GatewayClient.kt](clients/android/GatewayClient.kt) | OkHttp and Kotlin Coroutines |
| iOS | [GatewayClient.swift](clients/ios/GatewayClient.swift) | Apple CryptoKit and Security; async/await |
| Flutter | [gateway_client.dart](clients/flutter/gateway_client.dart) | `pointycastle`, `basic_utils`, `http` |
| Web | [gatewayClient.js](clients/web/gatewayClient.js) | Native WebCrypto and Fetch API |

Copy the helper for your platform into your app. Usage examples per platform are in [Client SDK integration](docs/client-sdks.md).

## Documentation

| Topic | Where |
| --- | --- |
| Hosted demo and direct-versus-gateway comparison | [docs/live-demo.md](docs/live-demo.md) |
| Deploy with Docker or Vercel | [docs/deployment.md](docs/deployment.md) |
| Client SDK usage (Android, iOS, Flutter, Web) | [docs/client-sdks.md](docs/client-sdks.md) |
| HTTP API, response modes, errors | [docs/api.md](docs/api.md) |
| Configuration and key management | [docs/configuration.md](docs/configuration.md) |
| Threat model and limitations | [docs/security.md](docs/security.md) |
| Panduan (Bahasa Indonesia) | [docs/PANDUAN.md](docs/PANDUAN.md) |

## Testing

```bash
npm test -- --runInBand        # Unit tests (crypto, validation, routes, controllers)
npm run test:e2e -- --runInBand # E2E tests (real gateway + mock upstream: both modes + defaults)
npm run test:clients           # Web SDK tests: both modes, forbidden fallbacks, corrupted ciphertext
npm run build                 # Application TypeScript compilation
```

The test suite verifies unpadded timestamp/nonce handling, idempotent repeat requests, DELETE bodies, proxy header filtering, decompressed response limits, invalid configuration rejections, per-IP rate limiting, and plaintext request rejections across all modes. E2E tests require permission to bind local test ports. Native client SDKs should be validated within their target Android, iOS, or Flutter projects prior to production releases.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

Copyright 2026 Jimmy Leonardo.
