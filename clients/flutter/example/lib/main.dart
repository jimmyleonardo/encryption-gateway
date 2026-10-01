import 'dart:convert';

import 'package:alice/alice.dart';
import 'package:alice/model/alice_configuration.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:samseer/samseer.dart';

import 'gateway_client.dart';
import 'gateway_alice_client.dart';
import 'gateway_samseer_client.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const GatewaySampleApp());
}

class GatewaySampleApp extends StatefulWidget {
  const GatewaySampleApp({super.key});

  @override
  State<GatewaySampleApp> createState() => _GatewaySampleAppState();
}

class _GatewaySampleAppState extends State<GatewaySampleApp> {
  static const inspectorName =
      String.fromEnvironment('INSPECTOR', defaultValue: 'samseer');
  final alice = kDebugMode && inspectorName == 'alice'
      ? Alice(
          configuration: AliceConfiguration(
              showNotification: false, showInspectorOnShake: false))
      : null;
  final inspector = kDebugMode && inspectorName == 'samseer'
      ? Samseer(
          configuration:
              const SamseerConfiguration(showInspectorOnShake: false))
      : null;
  final transport = http.Client();
  GatewaySamseerClient? api;
  GatewayAliceClient? aliceApi;
  String output = 'Loading gateway configuration…';
  bool busy = false;
  static const backend = String.fromEnvironment('BACKEND_ORIGIN');

  @override
  void initState() {
    super.initState();
    configure();
  }

  Future<void> configure() async {
    try {
      const gatewayUrl = String.fromEnvironment('GATEWAY_URL');
      const keyId = String.fromEnvironment('GATEWAY_KEY_ID');
      if (gatewayUrl.isEmpty || backend.isEmpty) {
        throw StateError(
            'Set GATEWAY_URL and BACKEND_ORIGIN using --dart-define.');
      }
      final gatewayUri = Uri.parse(gatewayUrl);
      final backendUri = Uri.parse(backend);
      if (gatewayUri.scheme != 'https' ||
          backendUri.scheme != 'https' ||
          gatewayUri.host.isEmpty ||
          backendUri.host.isEmpty ||
          backendUri.path.isNotEmpty && backendUri.path != '/' ||
          backendUri.hasQuery ||
          backendUri.hasFragment ||
          backendUri.userInfo.isNotEmpty) {
        throw StateError('Use HTTPS gateway and backend origin URLs.');
      }
      final pem = await rootBundle.loadString('assets/gateway_public.pem');
      if (!['samseer', 'alice'].contains(inspectorName)) {
        throw StateError('INSPECTOR must be samseer or alice.');
      }
      final gateway = GatewayClient(
        gatewayUrl: gatewayUri,
        serverPublicKeyPem: pem,
        keyId: keyId.isEmpty ? null : keyId,
        requireEncryptedResponse: true,
        httpClient: transport,
      );
      api = GatewaySamseerClient(
        gateway: gateway,
        inspector: inspector,
      );
      aliceApi = GatewayAliceClient(gateway: gateway, inspector: alice);
      if (mounted)
        setState(() => output = 'Ready. Send a request, then open Inspector.');
    } catch (error) {
      if (mounted) setState(() => output = 'Setup required:\n$error');
    }
  }

  Future<void> send(String method, String path, {Object? body}) async {
    setState(() {
      busy = true;
      output = 'Sending $method $path…';
    });
    try {
      const token = String.fromEnvironment('BACKEND_TOKEN');
      final sendRequest = inspectorName == 'alice' ? aliceApi!.send : api!.send;
      final result = await sendRequest(
        method: method,
        accessPoint: Uri.parse(backend).resolve(path).toString(),
        headers: {
          'Content-Type': 'application/json',
          if (token.isNotEmpty) 'Authorization': 'Bearer $token',
        },
        body: body,
      );
      if (mounted) {
        setState(() => output = 'Backend HTTP ${result.statusCode}\n'
            '${const JsonEncoder.withIndent('  ').convert(result.data)}');
      }
    } catch (error) {
      if (mounted) setState(() => output = '$error');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    transport.close();
    inspector?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        navigatorKey: alice?.getNavigatorKey() ?? inspector?.navigatorKey,
        theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
        home: Scaffold(
          appBar: AppBar(title: const Text('Gateway · Plain HTTP Inspector')),
          body: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              const Text(
                  'Requests use the encryption gateway. Inspector shows the plain request and decoded backend response.'),
              const SizedBox(height: 16),
              FilledButton(
                  onPressed: api == null || busy
                      ? null
                      : () => send('POST', '/api/login', body: {
                            'email': 'budi@example.com',
                            'password': 'demo-password',
                          }),
                  child: const Text('POST login')),
              FilledButton(
                  onPressed: api == null || busy
                      ? null
                      : () => send('GET', '/api/products?page=1&limit=10'),
                  child: const Text('GET products')),
              FilledButton(
                  onPressed: api == null || busy
                      ? null
                      : () => send('PATCH', '/api/profile', body: {
                            'name': 'Budi Santoso',
                            'email': 'invalid-email',
                          }),
                  child: const Text('PATCH profile · validation example')),
              if (inspector != null)
                OutlinedButton(
                    onPressed: inspector!.showInspector,
                    child: const Text('Open Inspector')),
              if (alice != null)
                OutlinedButton(
                    onPressed: alice!.showInspector,
                    child: const Text('Open Alice Inspector')),
              const SizedBox(height: 16),
              SelectableText(output),
            ],
          ),
        ),
      );
}
