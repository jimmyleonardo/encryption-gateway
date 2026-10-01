# Plain request/response inspection in Flutter with Samseer

[Alice](https://pub.dev/packages/alice) and [Chucker Flutter](https://pub.dev/packages/chucker_flutter) are established in-app HTTP inspectors. [Samseer](https://pub.dev/packages/samseer) is a newer alternative with a manual recording API. This sample uses **Samseer 0.5.0** to record the logical backend request before encryption and the backend response after decryption.

```text
Flutter app → GatewaySamseerClient records plain request
            → GatewayClient encrypts → encryption server → backend
            ← GatewayClient decrypts ← encryption server ← backend
            → Samseer records decoded response + backend status
```

No server changes or Aegis Guardian integration are required. Keep `ENCRYPT_RESPONSE=true`.

## Run the sample app

The [sample source](../clients/flutter/example/lib/main.dart) has three request buttons and an **Open Inspector** button. Its endpoints are examples: adapt `/api/login`, `/api/products`, and `/api/profile` to your backend. The backend must be allowed by the gateway's host/method policy.

The shared sample defaults to Samseer and also supports Alice through `--dart-define=INSPECTOR=alice`; see the [Alice guide](alice.md). Its pubspec includes both inspectors so either mode can be run. An existing app needs only its chosen inspector dependency and helper.

From the repository root:

```sh
cd clients/flutter/example
sh prepare.sh
flutter create --platforms=android,ios --project-name=gateway_inspector_sample --no-overwrite --no-pub .
flutter pub get
```

`prepare.sh` copies the current shared SDK helpers into the app's `lib/` folder; run it again after changing either helper. The next command generates the native app scaffolding while preserving the sample's existing Dart source and pubspec. The generated `test/widget_test.dart` is Flutter's starter counter test and does not apply to this app; it is excluded from analysis, and you should run the supplied test file explicitly.

Replace `assets/gateway_public.pem` with your deployment's **public PEM key**. The placeholder intentionally shows a setup message until configured. The public key and optional key ID must match your gateway deployment.

```sh
flutter run \
  --dart-define=GATEWAY_URL=https://gateway.example.com/api/gateway \
  --dart-define=BACKEND_ORIGIN=https://api.example.com \
  --dart-define=GATEWAY_KEY_ID=YOUR_KEY_ID
```

For authenticated endpoints, optionally pass `--dart-define=BACKEND_TOKEN=YOUR_TEST_TOKEN`. This is a demo convenience; in a real app, supply the current user's token from your authentication flow.

1. Tap **POST login** or **GET products**.
2. Tap **Open Inspector**.
3. Open the entry to see backend URL, method, headers, request body, status, and decoded response.
4. Tap **PATCH profile · validation example** to inspect a backend validation error. The actual status/content comes from your backend; the sample does not fabricate a 422 result.

## Integrate into an existing app

Copy [gateway_client.dart](../clients/flutter/gateway_client.dart) and [gateway_samseer_client.dart](../clients/flutter/gateway_samseer_client.dart) into the same folder under `lib/`. If you copy the sample's `main.dart` into another project, put both helpers alongside it or update its imports to their new paths.

Dependencies:

```yaml
dependencies:
  flutter:
    sdk: flutter
  samseer: 0.5.0
  http: ^1.6.0
  pointycastle: ^4.0.0
  basic_utils: ^5.8.2
```

After initializing the Flutter binding, create the clients:

```dart
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:samseer/samseer.dart';

final samseer = kDebugMode
    ? Samseer(configuration: const SamseerConfiguration(
        showInspectorOnShake: false,
      ))
    : null;

final transport = http.Client();
final api = GatewaySamseerClient(
  gateway: GatewayClient(
    gatewayUrl: Uri.parse('https://gateway.example.com/api/gateway'),
    serverPublicKeyPem: publicKeyPem,
    keyId: gatewayKeyId,
    requireEncryptedResponse: true,
    httpClient: transport,
  ),
  inspector: samseer,
);
```

Keep the gateway transport as a plain `http.Client`. Do not wrap it with `samseer.httpClient()` or enable `HttpOverrides.global = samseer.httpOverrides` for this setup: those inspect the encrypted gateway transport. The wrapper records readable logical transactions separately. Existing Dio interceptors attached to another client do not capture these calls automatically.

Wire the inspector to the app navigator:

```dart
MaterialApp(
  navigatorKey: samseer?.navigatorKey,
  home: YourHomeScreen(),
);

// Inside a debug menu:
if (samseer != null)
  OutlinedButton(
    onPressed: samseer.showInspector,
    child: const Text('Open Inspector'),
  );
```

Send requests using the same arguments as `GatewayClient.send`:

```dart
final result = await api.send(
  method: 'POST',
  accessPoint: 'https://api.example.com/api/login',
  headers: {'Content-Type': 'application/json'},
  body: {
    'email': 'budi@example.com',
    'password': 'demo-password',
  },
);
// Check result.statusCode and use result.data as before.

await api.send(
  method: 'GET',
  accessPoint: 'https://api.example.com/api/products?page=1&limit=10',
  headers: {'Authorization': 'Bearer $accessToken'},
);

await api.send(
  method: 'PATCH',
  accessPoint: 'https://api.example.com/api/profile',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  },
  body: {'name': 'Budi Santoso', 'email': 'invalid-email'},
);
```

The inspector displays results such as these **illustrative backend responses**:

```text
POST /api/login → 200
Request:  {"email":"budi@example.com","password":"demo-password"}
Response: {"success":true,"data":{"user":{"id":"usr_123","name":"Budi Santoso"},"accessToken":"demo-access-token","expiresIn":3600}}

GET /api/products?page=1&limit=10 → 200
Response: {"success":true,"data":[{"id":"prd_101","name":"Keyboard","price":450000},{"id":"prd_102","name":"Mouse","price":175000}],"pagination":{"page":1,"limit":10,"total":2}}

PATCH /api/profile → 422
Request:  {"name":"Budi Santoso","email":"invalid-email"}
Response: {"success":false,"error":{"code":"VALIDATION_FAILED","message":"Email is invalid","fields":{"email":["Must be a valid email address"]}}}
```

## Behavior and scope

- Requests appear before the transport finishes; responses attach to the same call ID after decryption. Concurrent calls have separate IDs.
- Samseer receives the original method, URL, application headers, JSON body, and query values. `parameter` values appear in the query section; the URL field remains the supplied `accessPoint`.
- Backend statuses such as 401/404/422 remain backend results, matching `GatewayClient.send` semantics. Response headers retain arrays, including separate `Set-Cookie` values.
- Gateway HTTP failures are shown with their status, readable message, and `x-gateway-error: true`; the wrapper still throws the original `GatewayException` to your app.
- Transport/decryption failures appear as failed entries without a successful response body.
- The wrapper records only in `kDebugMode`. The supplied sample creates no inspector in profile/release builds. Captured plain bodies include any tokens/passwords you supplied.
- The wrapper uses the existing SDK API rather than being a drop-in Dio adapter. It supports JSON-serializable inputs and buffered gateway results. It does not add streaming, multipart, automatic cookies, retries, or transport cancellation.
- The helper accepts the existing SDK's response policy. Plain response mode can be inspected by explicitly setting `requireEncryptedResponse: false`.

Dispose your `Samseer` instance and close the transport when their owning component is disposed. Use a transport timeout policy in your real app; this sample inherits the existing SDK's `http.Client` behavior.

## Verify

From `clients/flutter/example`:

```sh
flutter analyze lib test/gateway_samseer_test.dart
flutter test test/gateway_samseer_test.dart
```

Tests use the real Samseer library and RSA-OAEP/AES-GCM code, with a mock HTTP gateway transport. They verify plaintext capture, encrypted wire payloads, backend status/headers, response modes, readable gateway errors, authentication failures, no-recorder behavior, and the sample's setup screen. No live gateway is required for these tests. The full inspector UI and live requests need to be exercised in your configured Android/iOS app.
