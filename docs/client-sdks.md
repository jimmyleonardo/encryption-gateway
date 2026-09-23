# Client SDK integration

| Platform | SDK Helper | Dependencies |
|---|---|---|
| Android | [GatewayClient.kt](../clients/android/GatewayClient.kt) | OkHttp and Kotlin Coroutines |
| iOS | [GatewayClient.swift](../clients/ios/GatewayClient.swift) | Apple CryptoKit & Security; async/await |
| Flutter | [gateway_client.dart](../clients/flutter/gateway_client.dart) | `pointycastle`, `basic_utils`, `http` |
| Web | [gatewayClient.js](../clients/web/gatewayClient.js) | Native WebCrypto and Fetch API |

Copy the client helper into your client application codebase. All examples require the public key and `keyId` matching the gateway deployment. Set `requireEncryptedResponse=false` only if the client application is allowed to accept standard JSON responses. Across all modes, calling `send()` follows the identical developer experience.

## 📱 Android (Kotlin)

Place your public key PEM file at `res/raw/gateway_public.pem` and adjust the package namespace:

```kotlin
val publicPem = context.resources.openRawResource(R.raw.gateway_public)
    .bufferedReader().use { it.readText() }

val gateway = GatewayClient(
    gatewayUrl = "https://gateway.example.com/api/gateway",
    serverPublicKeyPem = publicPem,
    keyId = "KEY_ID_FROM_SERVER",
    requireEncryptedResponse = true // false: allows both response formats
)

// Execute inside a coroutine. The SDK handles all encryption/decryption.
val result = gateway.send(
    method = "POST",
    accessPoint = "https://api.example.com/api/login",
    headers = mapOf("Content-Type" to "application/json"),
    body = JSONObject().put("email", "user@example.com").put("password", "secret")
)

if (result.statusCode == 200) {
    // Access result.data and result.headers
}
```

## 🍏 iOS (Swift)

```swift
let gateway = try GatewayClient(
    gatewayURL: URL(string: "https://gateway.example.com/api/gateway")!,
    serverPublicKeyBase64: publicKeyPKCS1Base64,
    keyId: "KEY_ID_FROM_SERVER",
    requireEncryptedResponse = true // false: allows both response formats
)

let result = try await gateway.send(
    method = "GET",
    accessPoint: "https://api.example.com/api/profile",
    headers: ["Authorization": "Bearer \(token)"]
)
// Access result.statusCode, result.headers, and result.data
```

`publicKeyPKCS1Base64` is the public key embedded in the app, retrieved from the server's `pkcs1Base64` field.

## 💙 Flutter (Dart)

```dart
final gateway = GatewayClient(
  gatewayUrl: Uri.parse('https://gateway.example.com/api/gateway'),
  serverPublicKeyPem: publicKeyPem,
  keyId: 'KEY_ID_FROM_SERVER',
  requireEncryptedResponse: true, // false: allows both response formats
);

final result = await gateway.send(
  method: 'GET',
  accessPoint: 'https://api.example.com/api/profile',
  headers: {'Authorization': 'Bearer $token'},
);
// Access result.statusCode, result.headers, and result.data
```

`publicKeyPem` is loaded from bundled Flutter asset files.

## 🌐 Web (JavaScript)

```javascript
import { GatewayClient } from './gatewayClient.js';

const gateway = new GatewayClient(
  'https://gateway.example.com/api/gateway',
  publicKeyPem,
  'KEY_ID_FROM_SERVER',
  { requireEncryptedResponse: true } // false: allows both response formats
);

const { StatusCode, Headers, Data } = await gateway.send({
  method: 'GET',
  accessPoint: 'https://api.example.com/api/profile',
  headers: { Authorization: `Bearer ${token}` },
});
```

WebCrypto requires a secure context (HTTPS, or localhost during development). Configure `CORS_ORIGINS=https://app.example.com` on the gateway server. `Headers` are returned as a standard JSON object; response `Set-Cookie` headers are data fields and are not automatically set in the browser's cookie jar.
