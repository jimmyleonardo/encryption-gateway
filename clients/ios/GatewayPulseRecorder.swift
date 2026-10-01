// Add Pulse through Swift Package Manager. This bridge is compiled only for debug.
#if DEBUG && canImport(Pulse)
import Foundation
import Pulse

final class GatewayPulseRecorder: GatewayHTTPTraceRecorder {
    private let store: LoggerStore

    init(store: LoggerStore = .shared) { self.store = store }

    func record(_ trace: GatewayHTTPTrace) {
        // Manual recording stores the logical backend request and the decoded response.
        // The transport URLSession intentionally does not use URLSessionProxy.
        store.storeRequest(
            trace.request, response: trace.response, error: trace.error,
            data: trace.responseBody, label: "Encryption Gateway",
            taskDescription: "Decrypted backend transaction (\(Int(trace.duration * 1000)) ms)"
        )
    }
}
#endif
