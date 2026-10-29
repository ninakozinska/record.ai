import Foundation

/// A/B tests and events for the iPhone app, the same tests as the web app
/// (see docs/OPTIMIZATION.md). The device keeps a random id; the server links
/// it to the account at login. Events carry counts and choices only, never
/// note contents.
@MainActor
final class Insights {
    static let shared = Insights()

    let anonId: String
    var api: API?
    private(set) var variants: [String: String] = [:]
    private var queue: [[String: Any]] = []

    init(defaults: UserDefaults = .standard) {
        if let saved = defaults.string(forKey: "anonId") {
            anonId = saved
        } else {
            let fresh = UUID().uuidString
            defaults.set(fresh, forKey: "anonId")
            anonId = fresh
        }
    }

    /// Fetches this device's variants; offline, every test shows its first variant.
    func load() async {
        guard let api else { return }
        do {
            variants = try await api.experiments(anonId: anonId)
        } catch {
            // Offline: keep what we had.
        }
    }

    func variant(_ key: String, fallback: String) -> String {
        variants[key] ?? fallback
    }

    /// Queues an event; a click that decides a test ("upgrade_click") is sent at once.
    func track(_ name: String, _ props: [String: String] = [:]) {
        queue.append(["name": name, "ts": Int(Date().timeIntervalSince1970 * 1000), "props": props])
        if queue.count >= 20 || name == "upgrade_click" {
            Task { await flush() }
        }
    }

    /// Sends what is waiting; call it on a timer and when the app goes to the background.
    func flush() async {
        guard let api, !queue.isEmpty else { return }
        let batch = Array(queue.prefix(50))
        queue.removeFirst(batch.count)
        do {
            try await api.sendEvents(anonId: anonId, events: batch)
        } catch {
            queue.insert(contentsOf: batch, at: 0)
        }
    }
}
