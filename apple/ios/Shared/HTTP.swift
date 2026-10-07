import Foundation

/// Small JSON-over-HTTPS helper shared by both apps.
enum HTTP {
    enum Failure: LocalizedError {
        case badStatus(Int)
        case badPayload
        var errorDescription: String? {
            switch self {
            case .badStatus(let code): return "The server answered with HTTP \(code)."
            case .badPayload: return "The response was not in the expected format."
            }
        }
    }

    /// api.weather.gov rejects requests without a User-Agent that identifies the app.
    static let userAgent = "HoodaApple/0.1 (yashhooda.ai)"

    static func json(_ url: URL, accept: String = "application/json") async throws -> Any {
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw Failure.badStatus(http.statusCode)
        }
        return try JSONSerialization.jsonObject(with: data)
    }
}

extension Dictionary where Key == String, Value == Any {
    /// JSON numbers arrive as NSNumber, and some feeds send numbers as strings.
    func double(_ key: String) -> Double? {
        if let n = self[key] as? NSNumber { return n.doubleValue }
        if let s = self[key] as? String { return Double(s) }
        return nil
    }
    func string(_ key: String) -> String? { self[key] as? String }
}
