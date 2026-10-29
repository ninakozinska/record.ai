import Foundation

struct APIError: LocalizedError {
    var status: Int
    var message: String
    var errorDescription: String? { message }

    static let offline = APIError(status: 0, message: "Cannot reach your record.ai server. Is your Mac on, with record.ai running?")
}

/// Talks to the record.ai server (the same API the web app uses).
struct API {
    var baseURL: URL
    var token: String?

    /// A computer at home (an IP address, "localhost", a ".local" name, or anything
    /// with a port such as :3000) speaks plain http; a server on the internet
    /// (record-ai-nina.fly.dev) only https. A login sent over http to such a
    /// server is redirected and loses its password, so guessing right matters.
    static func isLocal(_ address: String) -> Bool {
        let host = String(address.split(separator: "/", maxSplits: 1).first ?? "")
        let name = String(host.split(separator: ":", maxSplits: 1).first ?? "")
        let parts = name.split(separator: ".")
        let isIP = parts.count == 4 && parts.allSatisfy { Int($0) != nil }
        return host.contains(":") || name == "localhost" || name.hasSuffix(".local") || isIP
    }

    /// Turns what the person typed ("172.20.10.2:3000") into a server URL.
    static func normalize(_ input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") {
            s = (isLocal(s) ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: s)
    }

    func url(_ path: String) -> URL {
        URL(string: baseURL.absoluteString + "/api/" + path)!
    }

    func request(_ path: String, method: String = "GET", json: [String: Any]? = nil,
                 body: Data? = nil, contentType: String? = nil) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        req.timeoutInterval = 20
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        } else if let body {
            req.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError.offline
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError(status: status, message: message ?? "Something went wrong (\(status)).")
        }
        return data
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        try JSONDecoder.server.decode(T.self, from: try await request(path))
    }

    func post<T: Decodable>(_ path: String, _ json: [String: Any], as type: T.Type) async throws -> T {
        try JSONDecoder.server.decode(T.self, from: try await request(path, method: "POST", json: json))
    }

    // MARK: A/B tests and events (see docs/OPTIMIZATION.md); work before logging in too

    /// The variant of every running A/B test for this device or account.
    func experiments(anonId: String) async throws -> [String: String] {
        let data = try await request("public/experiments?anon=\(anonId)&platform=ios")
        let answer = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return answer?["variants"] as? [String: String] ?? [:]
    }

    /// Sends events (what people do, never what they write); at most 50 per call.
    func sendEvents(anonId: String, events: [[String: Any]]) async throws {
        _ = try await request("public/events", method: "POST", json: ["anon": anonId, "platform": "ios", "events": events])
    }

    /// Checks that the address really is a record.ai server.
    func checkServer() async throws {
        let data = try await request("health")
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if obj?["ok"] as? Bool != true {
            throw APIError(status: 0, message: "That address answers, but it isn't a record.ai server.")
        }
    }

    // MARK: Live updates (Server-Sent Events)

    /// Streams (event, data) pairs until the connection drops.
    func events() -> AsyncThrowingStream<(String, Data), Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var req = URLRequest(url: url("events"))
                req.timeoutInterval = 70 // the server pings every 25 s
                if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else { throw APIError(status: status, message: "Live updates refused (\(status)).") }
                    var event = "message"
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                            continuation.yield((event, Data(payload.utf8)))
                            event = "message"
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
