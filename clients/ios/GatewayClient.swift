// clients/ios/GatewayClient.swift
// iOS 13+ — Pure Swift, zero third-party dependencies (CryptoKit & Security).

import CryptoKit
import Foundation
import Security

enum GatewayError: Error {
    case invalidKey
    /// Gateway error (400/429/502/504). `code`: UNKNOWN_KEY_ID, ...
    case gateway(status: Int, code: String?, message: String)
    case invalidResponse
    case encryptedResponseRequired
}

final class GatewayClient {
    private let gatewayURL: URL
    private let keyId: String?
    private let requireEncryptedResponse: Bool
    private let serverKey: SecKey

    /// - Parameters:
    ///   - gatewayURL: URL to gateway, e.g. URL(string: "https://gateway.example.com/api/gateway")!
    ///   - serverPublicKeyBase64: `pkcs1Base64` from GET /public-key or keygen output
    ///   - keyId: `keyId` from GET /public-key (optional)
    init(gatewayURL: URL, serverPublicKeyBase64: String, keyId: String? = nil, requireEncryptedResponse: Bool = true) throws {
        self.requireEncryptedResponse = requireEncryptedResponse
        self.gatewayURL = gatewayURL
        self.keyId = keyId
        guard let der = Data(base64Encoded: serverPublicKeyBase64) else {
            throw GatewayError.invalidKey
        }
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
        ]
        guard let key = SecKeyCreateWithData(der as CFData, attrs as CFDictionary, nil) else {
            throw GatewayError.invalidKey
        }
        self.serverKey = key
    }

    /// Sends a request through the encryption gateway.
    func send(
        method: String,
        accessPoint: String,
        headers: [String: String] = [:],
        body: Any? = nil,
        parameter: [String: Any]? = nil
    ) async throws -> (statusCode: Int, headers: [String: Any], data: Any) {
        var payload: [String: Any] = [
            "Method": method,
            "AccessPoint": accessPoint,
            "Header": headers.map { ["Key": $0.key, "Value": $0.value] },
        ]
        if let body { payload["Body"] = body }
        if let parameter { payload["Parameter"] = parameter }

        // 1. Fresh AES key for this request; 2. AES-256-GCM payload
        let aesKey = SymmetricKey(size: .bits256)
        let sealed = try AES.GCM.seal(try JSONSerialization.data(withJSONObject: payload), using: aesKey)

        // 3. RSA-OAEP-SHA256 encrypt AES key with gateway public key
        let rawKey = aesKey.withUnsafeBytes { Data($0) }
        var error: Unmanaged<CFError>?
        guard let encryptedKey = SecKeyCreateEncryptedData(
            serverKey, .rsaEncryptionOAEPSHA256, rawKey as CFData, &error
        ) as Data? else {
            throw GatewayError.invalidKey
        }

        var reqObj: [String: Any] = [
            "EncryptedKey": encryptedKey.base64EncodedString(),
            "IV": Data(sealed.nonce).base64EncodedString(),
            "Payload": (sealed.ciphertext + sealed.tag).base64EncodedString(),
        ]
        if let keyId { reqObj["KeyId"] = keyId }

        var request = URLRequest(url: gatewayURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: reqObj)

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard status == 200 else {
            let message = (json?["message"] as? [String])?.joined(separator: ", ")
                ?? json?["message"] as? String ?? ""
            throw GatewayError.gateway(status: status, code: json?["code"] as? String, message: message)
        }

        guard let envelope = json else { throw GatewayError.invalidResponse }
        let result: [String: Any]
        // JSONSerialization represents booleans as NSNumber. Check the CF type
        // so numeric 0/1 cannot masquerade as the encryption marker.
        let marker = envelope["Encrypted"] as? NSNumber
        let isBoolean = marker.map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false
        if isBoolean && marker?.boolValue == false {
            guard !requireEncryptedResponse else { throw GatewayError.encryptedResponseRequired }
            guard envelope["IV"] == nil, envelope["Payload"] == nil else { throw GatewayError.invalidResponse }
            result = envelope
        } else {
            guard envelope["Encrypted"] == nil || (isBoolean && marker?.boolValue == true),
                  let iv = (envelope["IV"] as? String).flatMap({ Data(base64Encoded: $0) }),
                  let box = (envelope["Payload"] as? String).flatMap({ Data(base64Encoded: $0) }),
                  box.count >= 16 else {
                throw GatewayError.invalidResponse
            }
            let plain = try AES.GCM.open(
                AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv),
                                  ciphertext: box.dropLast(16), tag: box.suffix(16)),
                using: aesKey)
            guard let decoded = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else {
                throw GatewayError.invalidResponse
            }
            result = decoded
        }
        guard let statusCode = result["StatusCode"] as? Int,
              (100...599).contains(statusCode), result["Headers"] is [String: Any],
              result["Data"] != nil else { throw GatewayError.invalidResponse }

        let respHeaders = result["Headers"] as? [String: Any] ?? [:]
        return (statusCode, respHeaders, result["Data"] ?? NSNull())
    }
}
