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

Android response headers use `Map<String, List<String>>`, preserving repeated values such as `Set-Cookie`. Read a single value with `result.headers["content-type"]?.firstOrNull()` and all cookies with `result.headers["set-cookie"].orEmpty()`. When updating an older copy of this helper, migrate code that previously expected header values to be strings.

### Read plain JSON in Chucker

For OkHttp/Retrofit apps, copy [GatewayOkHttpInterceptor.kt](../clients/android/GatewayOkHttpInterceptor.kt) alongside `GatewayClient.kt`. Put Chucker before the adapter on the logical backend client; use a separate transport for the encryption server. Chucker then captures the original request and decrypted backend response. See the [complete setup and examples](chucker.md).

## 🍏 iOS (Swift)

```swift
let gateway = try GatewayClient(
    gatewayURL: URL(string: "https://gateway.example.com/api/gateway")!,
    serverPublicKeyBase64: publicKeyPKCS1Base64,
    keyId: "KEY_ID_FROM_SERVER",
    requireEncryptedResponse: true // false: allows both response formats
)

let result = try await gateway.send(
    method: "GET",
    accessPoint: "https://api.example.com/api/profile",
    headers: ["Authorization": "Bearer \(token)"]
)
// Access result.statusCode, result.headers, and result.data
```

`publicKeyPKCS1Base64` is the public key embedded in the app, retrieved from the server's `pkcs1Base64` field.

### Read plain JSON in Pulse

For iOS, use [GatewayHTTPClient.swift](../clients/ios/GatewayHTTPClient.swift) with the debug-only [GatewayPulseRecorder.swift](../clients/ios/GatewayPulseRecorder.swift). Build an ordinary backend `URLRequest`, call `apiClient.data(for:)`, and open PulseUI to inspect the plaintext request and decrypted backend response. See the [complete Pulse setup](pulse.md).

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

### Read plain JSON in Samseer

Wrap the SDK with [gateway_samseer_client.dart](../clients/flutter/gateway_samseer_client.dart) to record requests before encryption and responses after decryption. The [sample app](../clients/flutter/example) includes three API actions and a Samseer inspector button. See the [complete setup guide](samseer.md).

### Read plain JSON in Alice

Use [gateway_alice_client.dart](../clients/flutter/gateway_alice_client.dart) to add completed plaintext transactions to Alice. Run the same sample with `--dart-define=INSPECTOR=alice`; the app then uses Alice's navigator and inspector button. See [Alice setup and compatibility](alice.md).

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
