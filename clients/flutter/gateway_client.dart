// clients/flutter/gateway_client.dart
// Dependencies in pubspec.yaml:
//   pointycastle: ^4.0.0
//   basic_utils: ^5.8.2
//   http: ^1.6.0

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:basic_utils/basic_utils.dart';
import 'package:http/http.dart' as http;
import 'package:pointycastle/export.dart';

class GatewayException implements Exception {
  final int status;
  final String? code;
  final String message;
  GatewayException(this.status, this.code, this.message);

  @override
  String toString() => 'GatewayException($status, code=$code): $message';
}

class GatewayResult {
  final int statusCode;
  final Map<String, dynamic> headers;
  final dynamic data;

  GatewayResult({
    required this.statusCode,
    required this.headers,
    required this.data,
  });
}

class GatewayClient {
  final Uri gatewayUrl;
  final String? keyId;
  final bool requireEncryptedResponse;
  final RSAPublicKey _serverKey;
  final http.Client _http;
  final Random _random = Random.secure();

  GatewayClient({
    required this.gatewayUrl,
    required String serverPublicKeyPem,
    this.keyId,
    this.requireEncryptedResponse = true,
    http.Client? httpClient,
  }) : _serverKey = CryptoUtils.rsaPublicKeyFromPem(serverPublicKeyPem),
       _http = httpClient ?? http.Client();

  /// Sends a request through the encryption gateway.
  Future<GatewayResult> send({
    required String method,
    required String accessPoint,
    Map<String, String> headers = const {},
    Object? body,
    Map<String, dynamic>? parameter,
  }) async {
    final payload = {
      'Method': method,
      'AccessPoint': accessPoint,
      'Header': headers.entries
          .map((e) => {'Key': e.key, 'Value': e.value})
          .toList(),
      if (body != null) 'Body': body,
      if (parameter != null) 'Parameter': parameter,
    };

    // 1. Fresh AES-256 key + IV for this request
    final aesKey = _bytes(32);
    final iv = _bytes(12);

    // 2. AES-256-GCM seal the payload (ciphertext + 16-byte tag)
    final sealed = _gcm(true, aesKey, iv, utf8.encode(jsonEncode(payload)));

    // 3. RSA-OAEP-SHA256 encrypt the AES key
    final rsa = OAEPEncoding.withSHA256(RSAEngine())
      ..init(true, PublicKeyParameter<RSAPublicKey>(_serverKey));

    final res = await _http.post(
      gatewayUrl,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        if (keyId != null) 'KeyId': keyId,
        'EncryptedKey': base64Encode(rsa.process(aesKey)),
        'IV': base64Encode(iv),
        'Payload': base64Encode(sealed),
      }),
    );

    final json = _tryJson(res.body);
    if (res.statusCode != 200) {
      final message = json?['message'];
      throw GatewayException(
        res.statusCode,
        json?['code'] as String?,
        message is List ? message.join(', ') : '${message ?? res.body}',
      );
    }

    if (json == null) throw const FormatException('Invalid gateway response');
    final Map<String, dynamic> result;
    if (json['Encrypted'] == false) {
      if (requireEncryptedResponse) {
        throw GatewayException(
          200,
          'ENCRYPTION_REQUIRED',
          'Encrypted response required; check ENCRYPT_RESPONSE on the server',
        );
      }
      if (json.containsKey('IV') || json.containsKey('Payload')) {
        throw const FormatException('Invalid gateway response');
      }
      result = json;
    } else {
      if (json.containsKey('Encrypted') && json['Encrypted'] != true) {
        throw const FormatException('Invalid gateway response');
      }
      // Legacy encrypted envelopes without a marker are also supported.
      final plain = _gcm(
        false,
        aesKey,
        base64Decode(json['IV'] as String),
        base64Decode(json['Payload'] as String),
      );
      result = jsonDecode(utf8.decode(plain)) as Map<String, dynamic>;
    }
    final statusCode = result['StatusCode'];
    if (statusCode is! int ||
        statusCode < 100 ||
        statusCode > 599 ||
        result['Headers'] is! Map<String, dynamic> ||
        !result.containsKey('Data')) {
      throw const FormatException('Invalid gateway response');
    }

    return GatewayResult(
      statusCode: statusCode,
      headers: (result['Headers'] as Map<String, dynamic>?) ?? {},
      data: result['Data'],
    );
  }

  Uint8List _bytes(int n) =>
      Uint8List.fromList(List.generate(n, (_) => _random.nextInt(256)));

  static Uint8List _gcm(
    bool encrypt,
    Uint8List key,
    Uint8List iv,
    List<int> input,
  ) {
    final gcm = GCMBlockCipher(AESEngine())
      ..init(encrypt, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
    return gcm.process(Uint8List.fromList(input));
  }

  static Map<String, dynamic>? _tryJson(String text) {
    try {
      return jsonDecode(text) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }
}
