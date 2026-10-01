import XCTest
import CryptoKit
import Foundation
import Security
import Combine
import Pulse
@testable import GatewayClientKit

private final class GatewayMockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Data, HTTPURLResponse))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (data, response) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class TraceRecorder: GatewayHTTPTraceRecorder {
    var traces: [GatewayHTTPTrace] = []
    func record(_ trace: GatewayHTTPTrace) { traces.append(trace) }
}

final class GatewayHTTPClientTests: XCTestCase {
    private var privateKey: SecKey!
    private var transport: URLSession!
    private var gateway: GatewayClient!
    private let recorder = TraceRecorder()
    private var requestCount = 0
    private var wireBody = Data()
    private var decryptedRequest: [String: Any] = [:]
    private var mode = true
    private var tamper = false
    private var status = 422
    private var gatewayStatus = 200
    private var contentType = "application/json"
    private var responseData: Any = ["success": false, "message": "Email is invalid"]

    override func setUpWithError() throws {
        privateKey = SecKeyCreateRandomKey([
            kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048
        ] as CFDictionary, nil)!
        let publicKey = SecKeyCopyPublicKey(privateKey)!
        let publicDer = SecKeyCopyExternalRepresentation(publicKey, nil)! as Data
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GatewayMockProtocol.self]
        transport = URLSession(configuration: configuration)
        gateway = try GatewayClient(gatewayURL: URL(string: "https://gateway.example.com/api/gateway")!,
            serverPublicKeyBase64: publicDer.base64EncodedString(), requireEncryptedResponse: false,
            transportSession: transport)
        GatewayMockProtocol.handler = { [unowned self] request in
            self.requestCount += 1
            XCTAssertEqual(request.url?.host, "gateway.example.com")
            self.wireBody = try Self.body(of: request)
            let outer = HTTPURLResponse(url: request.url!, statusCode: self.gatewayStatus, httpVersion: nil, headerFields: [:])!
            if self.gatewayStatus != 200 {
                return (try JSONSerialization.data(withJSONObject: ["message": "Upstream timed out"]), outer)
            }
            let envelope = try JSONSerialization.jsonObject(with: self.wireBody) as! [String: String]
            let rawKey = SecKeyCreateDecryptedData(self.privateKey, .rsaEncryptionOAEPSHA256,
                Data(base64Encoded: envelope["EncryptedKey"]!)! as CFData, nil)! as Data
            let key = SymmetricKey(data: rawKey)
            let sealed = Data(base64Encoded: envelope["Payload"]!)!
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Data(base64Encoded: envelope["IV"]!)!),
                ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
            self.decryptedRequest = try JSONSerialization.jsonObject(with: AES.GCM.open(box, using: key)) as! [String: Any]
            let result: [String: Any] = ["StatusCode": self.status,
                "Headers": ["content-type": self.contentType, "set-cookie": ["a=1", "b=2"]], "Data": self.responseData]
            if !self.mode {
                return (try JSONSerialization.data(withJSONObject: result.merging(["Encrypted": false]) { _, new in new }), outer)
            }
            let encrypted = try AES.GCM.seal(JSONSerialization.data(withJSONObject: result), using: key)
            var payload = encrypted.ciphertext + encrypted.tag
            if self.tamper { payload[payload.startIndex] ^= 1 }
            return (try JSONSerialization.data(withJSONObject: ["Encrypted": true,
                "IV": Data(encrypted.nonce).base64EncodedString(), "Payload": payload.base64EncodedString()]), outer)
        }
    }

    override func tearDown() {
        transport.invalidateAndCancel()
        GatewayMockProtocol.handler = nil
    }

    private static func body(of request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    private func request() -> URLRequest {
        var request = URLRequest(url: URL(string: "https://api.example.com/api/profile?tag=a&tag=b")!)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer demo-token", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{\"name\":\"Budi\",\"password\":\"demo-password\"}".utf8)
        return request
    }

    private func client(recorder: GatewayHTTPTraceRecorder? = nil) throws -> GatewayHTTPClient {
        try GatewayHTTPClient(gateway: gateway, backendOrigin: URL(string: "https://api.example.com/")!,
            recorder: recorder ?? self.recorder)
    }

    func testEncryptedWireAndPlaintextCaptureWithBackendStatus() async throws {
        let request = request()
        let (data, response) = try await client().data(for: request)
        XCTAssertEqual(response.statusCode, 422)
        XCTAssertEqual(response.url, request.url)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: data) as! [String: Any])["message"] as? String, "Email is invalid")
        XCTAssertFalse(String(data: wireBody, encoding: .utf8)!.contains("demo-password"))
        XCTAssertFalse(String(data: wireBody, encoding: .utf8)!.contains("demo-token"))
        XCTAssertEqual(decryptedRequest["AccessPoint"] as? String, request.url!.absoluteString)
        XCTAssertEqual((decryptedRequest["Body"] as! [String: Any])["name"] as? String, "Budi")
        XCTAssertEqual(recorder.traces.count, 1)
        XCTAssertEqual(recorder.traces[0].request.httpBody, request.httpBody)
        XCTAssertEqual(recorder.traces[0].responseBody, data)
        XCTAssertNil(recorder.traces[0].error)
    }

    func testPlainResponseModeProducesSameReadableResult() async throws {
        mode = false
        let (data, response) = try await client().data(for: request())
        XCTAssertEqual(response.statusCode, 422)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: data) as! [String: Any])["message"] as? String, "Email is invalid")
    }

    func testDeleteBodyIsForwarded() async throws {
        var request = request()
        request.httpMethod = "DELETE"
        _ = try await client().data(for: request)
        XCTAssertEqual(decryptedRequest["Method"] as? String, "DELETE")
        XCTAssertNotNil(decryptedRequest["Body"])
    }

    func testPlainTextResponseIsNotJsonQuoted() async throws {
        status = 200
        contentType = "text/plain"
        responseData = "Hello from backend"
        let (data, _) = try await client().data(for: request())
        XCTAssertEqual(String(data: data, encoding: .utf8), "Hello from backend")
    }

    func testBodylessStatusRemainsEmpty() async throws {
        status = 204
        responseData = NSNull()
        let (data, response) = try await client().data(for: request())
        XCTAssertTrue(data.isEmpty)
        XCTAssertEqual(response.statusCode, 204)
    }

    func testGatewayErrorIsReadableAndIdentified() async throws {
        gatewayStatus = 504
        let (data, response) = try await client().data(for: request())
        XCTAssertEqual(response.statusCode, 504)
        XCTAssertEqual(response.value(forHTTPHeaderField: "X-Gateway-Error"), "true")
        XCTAssertTrue(String(data: data, encoding: .utf8)!.contains("Upstream timed out"))
    }

    func testTamperedCiphertextRecordsFailureWithoutAPlainSuccess() async throws {
        tamper = true
        do { _ = try await client().data(for: request()); XCTFail("Expected GCM failure") }
        catch { XCTAssertNotNil(recorder.traces.last?.error); XCTAssertNil(recorder.traces.last?.responseBody) }
    }

    func testInvalidOriginIsRejectedBeforeTransport() async throws {
        var request = request()
        request.url = URL(string: "https://other.example.com/")!
        do { _ = try await client().data(for: request); XCTFail("Expected origin rejection") }
        catch { XCTAssertEqual(requestCount, 0) }
    }

    func testOversizedRequestIsRejectedBeforeTransport() async throws {
        var request = request()
        request.httpBody = Data(repeating: 65, count: 512 * 1024 + 1)
        do { _ = try await client().data(for: request); XCTFail("Expected size rejection") }
        catch { XCTAssertEqual(requestCount, 0) }
    }

    func testPulseReceivesActualPlainRequestAndDecryptedResponse() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".pulse")
        let store = try LoggerStore(storeURL: url, options: [.create])
        var event: LoggerStore.Event.NetworkTaskCompleted?
        let subscription = store.events.sink {
            if case .networkTaskCompleted(let completed) = $0 { event = completed }
        }
        defer { subscription.cancel() }
        let request = request()
        let (data, _) = try await client(recorder: GatewayPulseRecorder(store: store)).data(for: request)
        XCTAssertEqual(event?.requestBody, request.httpBody)
        XCTAssertEqual(event?.responseBody, data)
        XCTAssertEqual(event?.response?.statusCode, 422)
        XCTAssertEqual(event?.originalRequest.url, request.url)
        XCTAssertEqual(event?.label, "Encryption Gateway")
        XCTAssertNil(event?.error)
    }
}
