# Plain requests and decrypted responses in Alice for Flutter

Use [gateway_alice_client.dart](../clients/flutter/gateway_alice_client.dart) to record completed logical backend transactions with [Alice](https://pub.dev/packages/alice). This helper uses Alice's manual `addHttpCall` API: it saves the original plain request, awaits the encryption SDK, and attaches the decoded backend response and backend HTTP status.

```text
App → GatewayAliceClient keeps plain request
    → GatewayClient encrypts → gateway → backend
    ← GatewayClient decrypts ← gateway ← backend
    → Alice receives plain request + decoded response
```

Use a separate ordinary `http.Client` for the gateway transport. Automatic inspectors installed on that transport see the encrypted envelope. Aegis Guardian and gateway-server changes are not required.

## Try the shared sample

Follow the [Flutter sample setup](samseer.md#run-the-sample-app): run `sh prepare.sh`, generate Android/iOS scaffolding, install dependencies, and replace `assets/gateway_public.pem` with your trusted deployment's **public** key. Then choose Alice:

```sh
flutter run \
  --dart-define=INSPECTOR=alice \
  --dart-define=GATEWAY_URL=https://gateway.example.com/api/gateway \
  --dart-define=BACKEND_ORIGIN=https://api.example.com \
  --dart-define=GATEWAY_KEY_ID=YOUR_KEY_ID
```

The [sample app](../clients/flutter/example/lib/main.dart) offers POST login, GET products, PATCH profile, and **Open Alice Inspector**. Requests use example backend paths: adjust them to your own API and gateway allow-list. Alice entries appear after each operation completes.

Use `INSPECTOR=samseer` to select Samseer instead. Backend validation errors such as 422 remain readable responses rather than gateway HTTP 200 results.

## Add to an existing app

Copy `gateway_client.dart` and `gateway_alice_client.dart` into the same directory under `lib/`.

```yaml
dependencies:
  flutter:
    sdk: flutter
  alice: 1.2.0
  http: ^1.6.0
  basic_utils: ^5.8.2
  pointycastle: ^4.0.0
```

The tested sample pins **Alice 1.2.0**. Alice 1.11.0 requires Dart 3.13+, while the local verification uses Dart 3.12.2. Upgrading Alice requires rechecking its model/manual recording API and its platform dependency requirements. This helper does not depend on `alice_dio` or `alice_http`.

Create one inspector for the application after `WidgetsFlutterBinding.ensureInitialized()`:

```dart
import 'package:alice/alice.dart';
import 'package:alice/model/alice_configuration.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

final alice = kDebugMode
    ? Alice(configuration: AliceConfiguration(
        showNotification: false,
        showInspectorOnShake: false,
      ))
    : null;

final transport = http.Client();
final api = GatewayAliceClient(
  gateway: GatewayClient(
    gatewayUrl: Uri.parse('https://gateway.example.com/api/gateway'),
    serverPublicKeyPem: publicKeyPem,
    keyId: gatewayKeyId,
    requireEncryptedResponse: true,
    httpClient: transport,
  ),
  inspector: alice,
);
```

Attach Alice's navigator key to your existing root `MaterialApp`, and add a debug button:

```dart
MaterialApp(
  navigatorKey: alice?.getNavigatorKey(),
  home: YourHomeScreen(),
);

if (alice != null)
  OutlinedButton(
    onPressed: alice.showInspector,
    child: const Text('Open Alice Inspector'),
  );
```

Send requests as before:

```dart
final result = await api.send(
  method: 'PATCH',
  accessPoint: 'https://api.example.com/api/profile',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  },
  body: {'name': 'Budi Santoso', 'email': 'invalid-email'},
);
// result.statusCode and result.data retain GatewayClient semantics.
```

Example inspector entry, if your backend returns this validation result:

```text
PATCH https://api.example.com/api/profile
Request:  {"name":"Budi Santoso","email":"invalid-email"}
Status:   422
Response: {"success":false,"error":{"code":"VALIDATION_FAILED","message":"Email is invalid"}}
```

## Errors and limitations

- Gateway 400–599 errors appear as readable responses marked `x-gateway-error: true`. The original `GatewayException` still propagates to the app.
- Decryption/transport failures record an error with Alice's status `0` sentinel and no response body; they do not create successful backend responses.
- Alice 1.2.0 requires a response object on manually added calls. Entries are added on completion rather than while in flight.
- The response header model is `Map<String, String>`: repeated values are joined for display. Raw `GatewayResult.headers` still retains header arrays. Do not parse joined `Set-Cookie` values to implement a cookie jar.
- The wrapper records only in `kDebugMode`. It does not add streaming, retries, cancellation, automatic cookies, or new content types to the gateway SDK.
- Keep one app-lifetime Alice instance with notifications/shake disabled in this setup. Close the owned HTTP transport when the application component is disposed. Alice 1.2.0 does not expose a public `dispose()` method.

No private key belongs in any client resource. Generate your deployment key pair and distribute only the matching public key and key ID, as described in [README key setup](../README.md#which-keys-must-users-replace).

## Tests

The [shared Flutter tests](../clients/flutter/example/test/gateway_samseer_test.dart) exercise the actual Alice memory store and real RSA/AES response processing, including backend 422 capture, gateway 504, and ciphertext authentication failure. Follow the [sample verification commands](samseer.md#verify). Live gateway calls and the inspector UI should be verified in your configured app.
