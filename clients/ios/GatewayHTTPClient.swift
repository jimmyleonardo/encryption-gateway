import Foundation

/// A completed logical backend transaction, suitable for an in-app inspector.
struct GatewayHTTPTrace {
    let request: URLRequest
    let response: HTTPURLResponse?
    let responseBody: Data?
    let error: Error?
    let startedAt: Date
    let duration: TimeInterval
}

protocol GatewayHTTPTraceRecorder {
    func record(_ trace: GatewayHTTPTrace)
}

/// URLRequest adapter: sends through GatewayClient and returns the decoded backend body.
/// Pass a debug recorder to display plaintext instead of the encrypted transport envelope.
final class GatewayHTTPClient {
    private let gateway: GatewayClient
    private let origin: URLComponents
    private let recorder: GatewayHTTPTraceRecorder?
    private let maxBodyBytes: Int

    init(gateway: GatewayClient, backendOrigin: URL, recorder: GatewayHTTPTraceRecorder? = nil, maxBodyBytes: Int = 512 * 1024) throws {
        guard let origin = URLComponents(url: backendOrigin, resolvingAgainstBaseURL: false),
              origin.scheme == "https", origin.host != nil,
              origin.path.isEmpty || origin.path == "/",
              origin.query == nil, origin.fragment == nil,
              origin.user == nil, origin.password == nil, maxBodyBytes > 0 else {
            throw URLError(.badURL)
        }
        self.gateway = gateway
        self.origin = origin
        self.recorder = recorder
        self.maxBodyBytes = maxBodyBytes
    }

    /// Supports buffered JSON/text APIs; streaming and multipart are not supported.
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let startedAt = Date()
        var capturedResponse: HTTPURLResponse?
        var capturedBody: Data?
        var capturedError: Error?
        defer {
            recorder?.record(GatewayHTTPTrace(
                request: request, response: capturedResponse, responseBody: capturedBody,
                error: capturedError, startedAt: startedAt, duration: Date().timeIntervalSince(startedAt)
            ))
        }
        do {
            try Task.checkCancellation()
            guard let url = request.url,
                  let target = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  target.scheme == origin.scheme,
                  target.host?.lowercased() == origin.host?.lowercased(),
                  (target.port ?? 443) == (origin.port ?? 443),
                  target.user == nil, target.password == nil, target.fragment == nil else {
                throw URLError(.badURL)
            }
            let method = (request.httpMethod ?? "GET").uppercased()
            guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method),
                  request.httpBodyStream == nil else {
                throw URLError(.unsupportedURL)
            }
            let headers = request.allHTTPHeaderFields ?? [:]
            var body: Any?
            if let bytes = request.httpBody {
                guard bytes.count <= maxBodyBytes, method != "GET" else { throw URLError(.dataLengthExceedsMaximum) }
                let media = request.value(forHTTPHeaderField: "Content-Type")?
                    .split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
                if media == "application/json" || (media.hasPrefix("application/") && media.hasSuffix("+json")) {
                    body = try JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])
                } else if media.hasPrefix("text/"), let text = String(data: bytes, encoding: .utf8) {
                    body = text
                } else {
                    throw URLError(.cannotDecodeContentData)
                }
            }
            let result: (statusCode: Int, headers: [String: Any], data: Any)
            do {
                // Query parameters already belong to the logical URL and remain in AccessPoint.
                result = try await gateway.send(method: method, accessPoint: url.absoluteString, headers: headers, body: body)
            } catch GatewayError.gateway(let status, let code, let message) where (400...599).contains(status) {
                try Task.checkCancellation()
                var errorBody: [String: Any] = ["statusCode": status, "message": message]
                if let code { errorBody["code"] = code }
                let bytes = try JSONSerialization.data(withJSONObject: errorBody)
                guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [
                    "Content-Type": "application/json", "Cache-Control": "no-store", "X-Gateway-Error": "true"
                ]) else { throw GatewayError.invalidResponse }
                capturedBody = bytes
                capturedResponse = response
                return (bytes, response)
            }
            try Task.checkCancellation()
            guard (200...599).contains(result.statusCode) else { throw GatewayError.invalidResponse }
            let blocked = Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection", "content-encoding", "te", "trailer", "upgrade"])
            var responseHeaders: [String: String] = [:]
            for (name, value) in result.headers where !blocked.contains(name.lowercased()) {
                if let text = value as? String { responseHeaders[name] = text }
                else if let texts = value as? [String] { responseHeaders[name] = texts.joined(separator: ", ") }
                else { throw GatewayError.invalidResponse }
            }
            let contentType = responseHeaders.first { $0.key.lowercased() == "content-type" }?.value ?? "application/json"
            if !responseHeaders.keys.contains(where: { $0.lowercased() == "content-type" }) {
                responseHeaders["Content-Type"] = contentType
            }
            responseHeaders = responseHeaders.filter { $0.key.lowercased() != "cache-control" }
            responseHeaders["Cache-Control"] = "no-store"
            let media = contentType.split(separator: ";", maxSplits: 1).first?.lowercased() ?? "application/json"
            let bytes: Data
            if [204, 205, 304].contains(result.statusCode) { bytes = Data() }
            else if media == "application/json" || media.hasSuffix("+json") {
                bytes = try JSONSerialization.data(withJSONObject: result.data, options: [.fragmentsAllowed])
            } else if let text = result.data as? String { bytes = Data(text.utf8) }
            else if result.data is NSNull { bytes = Data() }
            else { throw GatewayError.invalidResponse }
            guard let response = HTTPURLResponse(url: url, statusCode: result.statusCode, httpVersion: "HTTP/1.1", headerFields: responseHeaders) else {
                throw GatewayError.invalidResponse
            }
            capturedResponse = response
            capturedBody = bytes
            return (bytes, response)
        } catch {
            capturedError = error
            throw error
        }
    }
}
