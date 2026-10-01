import 'dart:convert';
import 'dart:typed_data';

import 'package:basic_utils/basic_utils.dart';
import 'package:alice/alice.dart';
import 'package:alice/model/alice_configuration.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pointycastle/export.dart';
import 'package:samseer/samseer.dart';

import '../lib/gateway_client.dart';
import '../lib/gateway_alice_client.dart';
import '../lib/gateway_samseer_client.dart';
import '../lib/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AsymmetricKeyPair<PublicKey, PrivateKey> keys;
  late Samseer inspector;
  late http.Client transport;
  late GatewaySamseerClient client;
  late String wireBody;
  late Map<String, dynamic> decodedRequest;
  var encrypted = true;
  var corrupt = false;
  var gatewayStatus = 200;
  var backendStatus = 422;
  Object? responseBody = {'success': false, 'message': 'Email is invalid'};

  setUpAll(() {
    final random = FortunaRandom()
      ..seed(KeyParameter(Uint8List.fromList(List.generate(32, (i) => i + 1))));
    final generator = RSAKeyGenerator()
      ..init(ParametersWithRandom(
          RSAKeyGeneratorParameters(BigInt.from(65537), 2048, 64), random));
    keys = generator.generateKeyPair();
  });

  setUp(() {
    encrypted = true;
    corrupt = false;
    gatewayStatus = 200;
    backendStatus = 422;
    responseBody = {'success': false, 'message': 'Email is invalid'};
    inspector = Samseer(
        configuration: const SamseerConfiguration(showInspectorOnShake: false));
    transport = MockClient((request) async {
      wireBody = request.body;
      expect(request.url.host, 'gateway.example.com');
      if (gatewayStatus != 200) {
        return http.Response(
            jsonEncode(
                {'code': 'UPSTREAM_TIMEOUT', 'message': 'Upstream timed out'}),
            gatewayStatus);
      }
      final envelope = jsonDecode(wireBody) as Map<String, dynamic>;
      final rsa = OAEPEncoding.withSHA256(RSAEngine())
        ..init(
            false,
            PrivateKeyParameter<RSAPrivateKey>(
                keys.privateKey as RSAPrivateKey));
      final key = rsa.process(base64Decode(envelope['EncryptedKey'] as String));
      final decrypt = GCMBlockCipher(AESEngine())
        ..init(
            false,
            AEADParameters(KeyParameter(key), 128,
                base64Decode(envelope['IV'] as String), Uint8List(0)));
      decodedRequest = jsonDecode(utf8.decode(
              decrypt.process(base64Decode(envelope['Payload'] as String))))
          as Map<String, dynamic>;
      final result = {
        'StatusCode': backendStatus,
        'Headers': {
          'content-type': 'application/json',
          'set-cookie': ['a=1', 'b=2']
        },
        'Data': responseBody,
      };
      if (!encrypted)
        return http.Response(jsonEncode({'Encrypted': false, ...result}), 200);
      final iv = Uint8List.fromList(List.generate(12, (i) => i + 1));
      final encrypt = GCMBlockCipher(AESEngine())
        ..init(true, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
      final payload =
          encrypt.process(Uint8List.fromList(utf8.encode(jsonEncode(result))));
      if (corrupt) payload[0] ^= 1;
      return http.Response(
          jsonEncode({
            'Encrypted': true,
            'IV': base64Encode(iv),
            'Payload': base64Encode(payload)
          }),
          200);
    });
    client = GatewaySamseerClient(
      gateway: GatewayClient(
        gatewayUrl: Uri.parse('https://gateway.example.com/api/gateway'),
        serverPublicKeyPem:
            CryptoUtils.encodeRSAPublicKeyToPem(keys.publicKey as RSAPublicKey),
        httpClient: transport,
      ),
      inspector: inspector,
    );
  });

  tearDown(() {
    inspector.dispose();
    transport.close();
  });

  Future<GatewayResult> send() => client.send(
        method: 'PATCH',
        accessPoint: 'https://api.example.com/api/profile?tag=a&tag=b',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer demo-token'
        },
        body: {'name': 'Budi', 'password': 'demo-password'},
      );

  test(
      'real crypto wire hides secrets while Samseer receives plain request and decrypted backend 422',
      () async {
    final result = await send();
    expect(result.statusCode, 422);
    expect(wireBody, isNot(contains('demo-password')));
    expect(wireBody, isNot(contains('demo-token')));
    expect(
        decodedRequest['Body'], {'name': 'Budi', 'password': 'demo-password'});
    final call = inspector.calls.single;
    expect(call.uri, 'https://api.example.com/api/profile?tag=a&tag=b');
    expect(call.request.body, decodedRequest['Body']);
    expect(call.request.headers['Authorization'], 'Bearer demo-token');
    expect(call.request.queryParameters['tag'], ['a', 'b']);
    expect(call.status, 422);
    expect(call.response!.body, result.data);
    expect(call.response!.headers['set-cookie'], ['a=1', 'b=2']);
    expect(call.hasError, isFalse);
    expect(call.loading, isFalse);
  });

  test('explicit plain response mode is also inspectable', () async {
    encrypted = false;
    client = GatewaySamseerClient(
        gateway: GatewayClient(
          gatewayUrl: Uri.parse('https://gateway.example.com/api/gateway'),
          serverPublicKeyPem: CryptoUtils.encodeRSAPublicKeyToPem(
              keys.publicKey as RSAPublicKey),
          httpClient: transport,
          requireEncryptedResponse: false,
        ),
        inspector: inspector);
    final result = await send();
    expect(inspector.calls.single.response!.body, result.data);
  });

  test('plain response rejected by encrypted-only policy records failure',
      () async {
    encrypted = false;
    await expectLater(send(), throwsA(isA<GatewayException>()));
    expect(inspector.calls.single.hasError, isTrue);
    expect(inspector.calls.single.response, isNull);
  });

  test('gateway 504 is readable, identified and still thrown to app', () async {
    gatewayStatus = 504;
    await expectLater(send(), throwsA(isA<GatewayException>()));
    final call = inspector.calls.single;
    expect(call.status, 504);
    expect(call.response!.headers['x-gateway-error'], 'true');
    expect(call.response!.body,
        {'code': 'UPSTREAM_TIMEOUT', 'message': 'Upstream timed out'});
  });

  test('authentication failure completes as error without decoded success',
      () async {
    corrupt = true;
    await expectLater(send(), throwsA(isA<InvalidCipherTextException>()));
    expect(inspector.calls.single.hasError, isTrue);
    expect(inspector.calls.single.response, isNull);
    expect(inspector.calls.single.loading, isFalse);
  });

  test('text result and backend success status are retained', () async {
    backendStatus = 200;
    responseBody = 'Hello from backend';
    await send();
    expect(inspector.calls.single.response!.body, 'Hello from backend');
    expect(inspector.calls.single.status, 200);
  });

  test('optional recorder leaves gateway behavior available', () async {
    client = GatewaySamseerClient(gateway: client.gateway);
    final result = await send();
    expect(result.statusCode, 422);
    expect(inspector.calls, isEmpty);
  });

  Future<GatewayResult> sendAlice(Alice alice) => GatewayAliceClient(
        gateway: client.gateway,
        inspector: alice,
      ).send(
          method: 'PATCH',
          accessPoint: 'https://api.example.com/api/profile',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer demo-token'
          },
          body: {
            'name': 'Budi',
            'password': 'demo-password'
          });

  Alice createAlice(AliceMemoryStorage storage) => Alice(
          configuration: AliceConfiguration(
        storage: storage,
        showNotification: false,
        showInspectorOnShake: false,
      ));

  test('Alice stores real decrypted result and original request', () async {
    final storage = AliceMemoryStorage(maxCallsCount: 10);
    final result = await sendAlice(createAlice(storage));
    final call = storage.getCalls().single;
    expect(call.request!.body, decodedRequest['Body']);
    expect(call.request!.headers['Authorization'], 'Bearer demo-token');
    expect(call.response!.body, result.data);
    expect(call.response!.status, 422);
    expect(call.response!.headers!['set-cookie'], 'a=1, b=2');
    expect(call.loading, isFalse);
    expect(wireBody, isNot(contains('demo-password')));
  });

  test('Alice records gateway HTTP error while preserving exception', () async {
    gatewayStatus = 504;
    final storage = AliceMemoryStorage(maxCallsCount: 10);
    await expectLater(
        sendAlice(createAlice(storage)), throwsA(isA<GatewayException>()));
    final call = storage.getCalls().single;
    expect(call.response!.status, 504);
    expect(call.response!.headers!['x-gateway-error'], 'true');
    expect(call.loading, isFalse);
  });

  test('Alice records authentication failure without a success response',
      () async {
    corrupt = true;
    final storage = AliceMemoryStorage(maxCallsCount: 10);
    await expectLater(sendAlice(createAlice(storage)),
        throwsA(isA<InvalidCipherTextException>()));
    final call = storage.getCalls().single;
    expect(call.error, isNotNull);
    expect(call.response!.status, 0);
    expect(call.response!.body, isNull);
    expect(call.loading, isFalse);
  });

  testWidgets('sample opens with setup instructions and three request buttons',
      (tester) async {
    await tester.pumpWidget(const GatewaySampleApp());
    await tester.pump();
    expect(find.textContaining('Setup required:'), findsOneWidget);
    expect(find.text('POST login'), findsOneWidget);
    expect(find.text('GET products'), findsOneWidget);
    expect(find.textContaining('PATCH profile'), findsOneWidget);
    const selectedInspector =
        String.fromEnvironment('INSPECTOR', defaultValue: 'samseer');
    expect(
        find.text(selectedInspector == 'alice'
            ? 'Open Alice Inspector'
            : 'Open Inspector'),
        findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
