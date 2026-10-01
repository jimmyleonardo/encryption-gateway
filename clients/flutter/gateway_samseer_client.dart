import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:samseer/samseer.dart';

import 'gateway_client.dart';

/// Records logical backend transactions around GatewayClient's encryption.
/// Keep the gateway's http.Client unwrapped to avoid ciphertext-only entries.
class GatewaySamseerClient {
  final GatewayClient gateway;
  final Samseer? inspector;

  GatewaySamseerClient({required this.gateway, this.inspector});

  Future<GatewayResult> send({
    required String method,
    required String accessPoint,
    Map<String, String> headers = const {},
    Object? body,
    Map<String, dynamic>? parameter,
  }) async {
    // Snapshot JSON values: later changes in app state cannot alter this trace.
    final requestBody = body == null ? null : jsonDecode(jsonEncode(body));
    final requestHeaders = Map<String, String>.from(headers);
    final parameters = parameter == null
        ? null
        : jsonDecode(jsonEncode(parameter)) as Map<String, dynamic>;
    final logger = kDebugMode ? inspector : null;
    final uri = Uri.parse(accessPoint);
    final id = logger?.recordRequest(
      method: method,
      uri: accessPoint,
      client: 'Encryption Gateway',
      headers: requestHeaders,
      queryParameters: {
        ...uri.queryParametersAll,
        if (parameters != null) ...parameters,
      },
      body: requestBody,
      contentType: requestHeaders.entries
          .where((entry) => entry.key.toLowerCase() == 'content-type')
          .map((entry) => entry.value)
          .firstOrNull,
      size: requestBody == null
          ? 0
          : utf8.encode(jsonEncode(requestBody)).length,
    );
    try {
      final result = await gateway.send(
        method: method,
        accessPoint: accessPoint,
        headers: requestHeaders,
        body: requestBody,
        parameter: parameters,
      );
      if (id != null) {
        logger!.recordResponse(
          id,
          status: result.statusCode,
          headers: Map<String, dynamic>.from(result.headers),
          body: jsonDecode(jsonEncode(result.data)),
        );
      }
      return result;
    } on GatewayException catch (error, stack) {
      if (id != null) {
        if (error.status >= 400 && error.status <= 599) {
          logger!.recordResponse(
            id,
            status: error.status,
            headers: {
              'content-type': 'application/json',
              'x-gateway-error': 'true',
            },
            body: {
              'message': error.message,
              if (error.code != null) 'code': error.code,
            },
          );
        } else {
          logger!.recordError(
            id,
            message: error.toString(),
            error: error,
            stackTrace: stack,
          );
        }
      }
      rethrow;
    } catch (error, stack) {
      if (id != null) {
        logger!.recordError(
          id,
          message: error.toString(),
          error: error,
          stackTrace: stack,
        );
      }
      rethrow;
    }
  }
}
