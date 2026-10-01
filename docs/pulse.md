# Read plain requests and responses in Pulse on iOS

[Pulse](https://github.com/kean/Pulse) is an in-app network inspector for Apple platforms. Its `PulseUI` console can show backend URLs, HTTP methods, request headers/bodies, backend statuses, and response bodies. [Netfox](https://github.com/kasketis/netfox) is another established iOS inspector; this implementation uses Pulse's manual request/response recording API.

The integration records a completed logical backend transaction:

```text
App builds a plain URLRequest
  → GatewayHTTPClient keeps the original request for inspection
  → GatewayClient encrypts and sends through a separate URLSession
  → encryption server decrypts and forwards to the backend
  ← encryption server returns an encrypted response
  ← GatewayClient decrypts
  ← GatewayHTTPClient restores the backend response body and status
  → GatewayPulseRecorder writes the plain request + decoded response to Pulse
  → PulseUI displays the transaction
```

No encryption-server changes are required. `ENCRYPT_RESPONSE=true` can stay enabled.

## 1. Add Pulse and the helper files

In Xcode, choose **File → Add Package Dependencies**, add `https://github.com/kean/Pulse`, and select the `Pulse` and `PulseUI` products for your app target. Use an iOS 15+ compatible release and commit your resolved package version in your app.

Copy these files into the app target:

- [GatewayClient.swift](../clients/ios/GatewayClient.swift)
- [GatewayHTTPClient.swift](../clients/ios/GatewayHTTPClient.swift)
- [GatewayPulseRecorder.swift](../clients/ios/GatewayPulseRecorder.swift)

The existing SDK remains usable directly through `gateway.send(...)`. It now also accepts an injectable `transportSession`; the default remains `URLSession.shared`.

`GatewayPulseRecorder` is compiled only when `DEBUG` is defined and the app target can import Pulse. The core helpers do not require Pulse to build in release configurations.

## 2. Create the transport and logical API client

`publicKeyPKCS1Base64` and `gatewayKeyId` are the key values bundled with your application, obtained from your trusted gateway deployment's `/public-key` output.

```swift
import Foundation

let configuration = URLSessionConfiguration.ephemeral
configuration.timeoutIntervalForRequest = 30
configuration.timeoutIntervalForResource = 30
let transport = URLSession(configuration: configuration)

let gateway = try GatewayClient(
    gatewayURL: URL(string: "https://gateway.example.com/api/gateway")!,
    serverPublicKeyBase64: publicKeyPKCS1Base64,
    keyId: gatewayKeyId,
    requireEncryptedResponse: true,
    transportSession: transport
)

let recorder: GatewayHTTPTraceRecorder?
#if DEBUG
recorder = GatewayPulseRecorder()
#else
recorder = nil
#endif

let apiClient = try GatewayHTTPClient(
    gateway: gateway,
    backendOrigin: URL(string: "https://api.example.com/")!,
    recorder: recorder
)
```

Keep the transport as a plain `URLSession`. For this setup, do not install Pulse's automatic global proxy or `URLSessionProxy` on the transport: those capture the encrypted `/api/gateway` transaction separately. The manual recorder supplies the readable logical request and decrypted response.

## 3. Send the plain request through the adapter

Build the same backend `URLRequest` your app would normally send. Put Authorization and other application headers on it before calling the adapter:

```swift
var request = URLRequest(url: URL(string: "https://api.example.com/api/profile")!)
request.httpMethod = "PATCH"
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
request.httpBody = try JSONSerialization.data(withJSONObject: [
    "name": "Budi Santoso",
    "email": "invalid-email"
])

let (data, response) = try await apiClient.data(for: request)
print(response.statusCode) // Backend status, e.g. 422.
let json = try JSONSerialization.jsonObject(with: data)
```

Replace calls to `URLSession.shared.data(for: request)` for these backend endpoints with `apiClient.data(for: request)`. The adapter returns the backend response body, suitable for your existing `JSONDecoder`; it removes the `{StatusCode, Headers, Data}` gateway envelope.

For query parameters, build the query in the request URL using `URLComponents`. That complete URL is preserved in the encrypted `AccessPoint`. POST/PUT/PATCH/DELETE JSON bodies are forwarded.

## 4. Open the Pulse console inside the app

For a SwiftUI app, add a debug-only screen:

```swift
#if DEBUG
import SwiftUI
import PulseUI

struct GatewayNetworkDebugView: View {
    var body: some View {
        ConsoleView(mode: .network)
    }
}
#endif
```

Present `GatewayNetworkDebugView()` from a debug menu or sheet. For UIKit, present it through `UIHostingController(rootView: GatewayNetworkDebugView())`.

A recorded transaction is labeled **Encryption Gateway** and displays:

```text
URL: https://api.example.com/api/profile
Method: PATCH

Request:
{"name":"Budi Santoso","email":"invalid-email"}

Response status: 422
Response:
{"success":false,"error":{"code":"VALIDATION_FAILED","message":"Email is invalid"}}
```

Plain requests and decrypted responses are stored locally in the inspector. Enable the recorder on debug builds only. Header/body redaction can be added to the recorder if required by your application's debug-data policy.

## What gets recorded

- The original backend URL, method, headers, and plain request body.
- The restored backend response status, headers, and decoded body.
- Gateway errors such as 400/429/502/504 as readable responses marked `X-Gateway-Error: true`.
- Transport, validation, cancellation, and ciphertext authentication failures as failed transactions.

Pulse entries appear when the operation finishes. They represent a logical backend transaction, not a direct backend socket. Total elapsed milliseconds are included in the task description; manual recording does not supply DNS/TLS/network-task timing metrics.

Plain response mode also works if `GatewayClient` is explicitly configured with `requireEncryptedResponse: false`. Authentication failures never become plaintext successes.

The adapter supports buffered UTF-8 JSON/text request bodies up to 512 KiB by default, one HTTPS backend origin, and GET/POST/PUT/PATCH/DELETE. Request streams, multipart, and arbitrary binary bodies are rejected. Server `MAX_BODY_SIZE` includes encryption/base64 overhead. Task cancellation propagates into the async transport call. Response bodies for 204/205/304 remain empty.

Foundation's `HTTPURLResponse` uses a header dictionary: repeated header arrays are displayed as joined values. Use the raw `gateway.send(...).headers` result when separate `Set-Cookie` values are required. This adapter does not automatically persist backend cookies in a cookie jar.

## Tests

[GatewayHTTPClientTests.swift](../test/ios/GatewayHTTPClientTests.swift) uses a mock transport URLProtocol and the actual RSA-OAEP/AES-GCM code. It tests readable traces, encrypted wire payloads, both response modes, DELETE bodies, text/bodyless responses, gateway errors, ciphertext corruption, request limits, and origin rejection. Its Pulse-specific test checks the real `LoggerStore` event for the original plaintext request and decrypted response.

Copy the test into an XCTest target, add the `Pulse` dependency, and adjust `@testable import GatewayClientKit` to your app/helper module's name. Enable `DEBUG` for the test build. No live server or simulator network ports are needed. Actual PulseUI display is checked by opening the debug console in your app.

Validation: all 10 tests passed in a native macOS XCTest harness using Pulse commit `687b4faf573a5ed5fb7221af1972e8d8993d6f48`; the core helpers also passed compiler type checking for an iOS 15 simulator target. The console has not been launched in an iOS app during this verification.

The recorder API is documented in Pulse's [network logging guide](https://github.com/kean/Pulse/blob/main/Sources/Pulse/Pulse.docc/Articles/NetworkLogging-Article.md).
