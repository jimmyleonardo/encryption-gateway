import 'dart:convert';

import 'package:alice/alice.dart';
import 'package:alice/model/alice_http_call.dart';
import 'package:alice/model/alice_http_error.dart';
import 'package:alice/model/alice_http_request.dart';
import 'package:alice/model/alice_http_response.dart';
import 'package:flutter/foundation.dart';

import 'gateway_client.dart';

/// Alice 1.2.0 manual recording around the encryption SDK.
/// Completed logical transactions are added after response decryption.
class GatewayAliceClient {
  final GatewayClient gateway;
  final Alice? inspector;
  static int _nextId = 0;

  GatewayAliceClient({required this.gateway, this.inspector});

  Future<GatewayResult> send({
    required String method,
    required String accessPoint,
    Map<String, String> headers = const {},
    Object? body,
    Map<String, dynamic>? parameter,
  }) async {
    final logger = kDebugMode ? inspector : null;
    if (logger == null) {
      return gateway.send(
        method: method,
        accessPoint: accessPoint,
        headers: headers,
        body: body,
        parameter: parameter,
      );
    }
    final uri = Uri.parse(accessPoint);
    final requestBody = body == null ? null : jsonDecode(jsonEncode(body));
    final requestHeaders = Map<String, String>.from(headers);
    final parameters = parameter == null
        ? null
        : jsonDecode(jsonEncode(parameter)) as Map<String, dynamic>;
    final request = AliceHttpRequest()
      ..body = requestBody
      ..headers = requestHeaders
      ..queryParameters = {
        ...uri.queryParametersAll,
        if (parameters != null) ...parameters,
      }
      ..contentType = requestHeaders.entries
          .where((entry) => entry.key.toLowerCase() == 'content-type')
          .map((entry) => entry.value)
          .firstOrNull
      ..size = requestBody == null
          ? 0
          : utf8.encode(jsonEncode(requestBody)).length;
    final call = AliceHttpCall(++_nextId)
      ..client = 'Encryption Gateway'
      ..method = method.toUpperCase()
      ..uri = accessPoint
      ..server = uri.host
      ..endpoint = uri.path
      ..secure = uri.scheme == 'https'
      ..request = request;
    final watch = Stopwatch()..start();
    try {
      final result = await gateway.send(
        method: method,
        accessPoint: accessPoint,
        headers: requestHeaders,
        body: requestBody,
        parameter: parameters,
      );
      call.response = AliceHttpResponse()
        ..status = result.statusCode
        ..headers = result.headers.map(
          (name, value) => MapEntry(
            name,
            value is List ? value.join(', ') : value.toString(),
          ),
        )
        ..body = jsonDecode(jsonEncode(result.data))
        ..size = utf8.encode(jsonEncode(result.data)).length;
      return result;
    } on GatewayException catch (error, stack) {
      if (error.status >= 400 && error.status <= 599) {
        call.response = AliceHttpResponse()
          ..status = error.status
          ..headers = {
            'content-type': 'application/json',
            'x-gateway-error': 'true',
          }
          ..body = {
            'message': error.message,
            if (error.code != null) 'code': error.code,
          };
      } else {
        call.error = AliceHttpError()
          ..error = error
          ..stackTrace = stack;
      }
      rethrow;
    } catch (error, stack) {
      call.error = AliceHttpError()
        ..error = error
        ..stackTrace = stack;
      rethrow;
    } finally {
      watch.stop();
      call.loading = false;
      call.duration = watch.elapsedMilliseconds;
      // Alice requires a response object even for transport/decryption errors.
      // Status 0 is Alice's error sentinel, not a successful HTTP status.
      call.response ??= AliceHttpResponse()
        ..status = 0
        ..body = null;
      logger.addHttpCall(call);
    }
  }
}
