import Foundation
import Observation
import UIKit

/// A change waiting to be sent to the server (kept on disk, so nothing is lost offline).
struct OutboxItem: Codable {
    var kind: String          // "note" or "image"
    var id: String            // note id or image file name
    var body: Data?           // JSON object with the changed note fields
}

private struct HelloEvent: Codable {
    var ai: AIStatus
}

private struct Cache: Codable {
    var userId: String?
    var rev: Int
    var notes: [Note]
    var outbox: [OutboxItem]
}

/// Holds the notes, saves them on the phone, and keeps them in sync with the server.
@MainActor
@Observable
final class NoteStore {
    // Connection & account
    private(set) var serverURL: URL?
    private(set) var user: User?
    private(set) var signupPolicy: SignupPolicy?
    private(set) var online = false
    private(set) var unsent = 0
    private(set) var ai: AIStatus?

    // Data
    private(set) var notes: [String: Note] = [:]
    @ObservationIgnored private var rev = 0
    @ObservationIgnored private var outbox: [OutboxItem] = []
    @ObservationIgnored private var cachedUserId: String?

    @ObservationIgnored private var token: String?
    @ObservationIgnored private var liveTask: Task<Void, Never>?
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var pulling = false

    var api: API? { serverURL.map { API(baseURL: $0, token: token) } }
    var isLoggedIn: Bool { user != nil && token != nil }
    /// True until the server says otherwise, so the "AI is off" hint doesn't flash.
    var isAIEnabled: Bool { ai?.enabled ?? true }

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL").flatMap { URL(string: $0) }
        token = Keychain.load("token")
        if let data = UserDefaults.standard.data(forKey: "user") {
            user = try? JSONDecoder().decode(User.self, from: data)
        }
        loadCache()
    }

    // MARK: Files

    private static var folder: URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("record.ai", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private static var cacheFile: URL { folder.appendingPathComponent("notes.json") }
    static var imagesFolder: URL {
        let url = folder.appendingPathComponent("images", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func loadCache() {
        guard let data = try? Data(contentsOf: Self.cacheFile),
              let cache = try? JSONDecoder.server.decode(Cache.self, from: data) else { return }
        cachedUserId = cache.userId
        rev = cache.rev
        outbox = cache.outbox
        notes = Dictionary(uniqueKeysWithValues: cache.notes.map { ($0.id, $0) })
        unsent = outbox.count
    }

    private func saveCache() {
        let cache = Cache(userId: cachedUserId, rev: rev, notes: Array(notes.values), outbox: outbox)
        if let data = try? JSONEncoder.cache.encode(cache) {
            try? data.write(to: Self.cacheFile, options: [.atomic, .completeFileProtection])
        }
        unsent = outbox.count
    }

    private func wipeLocalData() {
        notes = [:]
        rev = 0
        outbox = []
        cachedUserId = nil
        try? FileManager.default.removeItem(at: Self.cacheFile)
        try? FileManager.default.removeItem(at: Self.imagesFolder)
        saveCache()
    }

    // MARK: Server & account

    func connect(to input: String) async throws {
        guard let url = API.normalize(input) else {
            throw APIError(status: 0, message: "Please enter the address shown in the web app.")
        }
        try await API(baseURL: url, token: nil).checkServer()
        serverURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        try? await refreshAuthState()
    }

    func forgetServer() {
        stopLive()
        serverURL = nil
        UserDefaults.standard.removeObject(forKey: "serverURL")
        setUser(nil)
        setToken(nil)
        wipeLocalData()
    }

    private func setToken(_ value: String?) {
        token = value
        if let value { Keychain.save(value, for: "token") } else { Keychain.delete("token") }
    }

    func refreshAuthState() async throws {
        guard let api else { return }
        let state = try await api.get("auth/state", as: AuthState.self)
        signupPolicy = state.signup
        if state.user == nil, token != nil {
            // Our session ended (password changed, logged out elsewhere).
            setToken(nil)
            setUser(nil)
        }
    }

    func login(email: String, password: String) async throws {
        guard let api else { return }
        let result = try await api.post("auth/login", ["email": email, "password": password], as: AuthResult.self)
        signedIn(result)
    }

    func signup(name: String, email: String, password: String, code: String) async throws {
        guard let api else { return }
        let result = try await api.post("auth/signup",
                                        ["name": name, "email": email, "password": password, "code": code],
                                        as: AuthResult.self)
        signedIn(result)
    }

    private func signedIn(_ result: AuthResult) {
        if cachedUserId != nil && cachedUserId != result.user.id { wipeLocalData() }
        cachedUserId = result.user.id
        setToken(result.token)
        setUser(result.user)
        saveCache()
        start()
    }

    private func setUser(_ user: User?) {
        self.user = user
        if let user, let data = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(data, forKey: "user")
        } else {
            UserDefaults.standard.removeObject(forKey: "user")
        }
    }

    /// Logs out and removes this account's notes from the phone.
    func logout() async {
        stopLive()
        if let api { _ = try? await api.request("auth/logout", method: "POST", json: [:]) }
        setToken(nil)
        setUser(nil)
        wipeLocalData()
        try? await refreshAuthState()
    }

    func changePassword(current: String, new: String) async throws {
        guard let api else { return }
        _ = try await api.request("auth/password", method: "POST", json: ["current": current, "next": new])
    }

    func logoutOtherDevices() async throws {
        guard let api else { return }
        _ = try await api.request("auth/logout-others", method: "POST", json: [:])
    }

    private func handleUnauthorized(_ error: Error) {
        if let e = error as? APIError, e.status == 401 {
            stopLive()
            setToken(nil)
            setUser(nil)
            online = false
        }
    }

    // MARK: Sync

    /// Call when the app comes to the foreground.
    func start() {
        guard isLoggedIn else { return }
        Task {
            await pull()
            await flush()
        }
        startLive()
    }

    func stopLive() {
        liveTask?.cancel()
        liveTask = nil
    }

    private func startLive() {
        guard liveTask == nil, let api else { return }
        liveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    for try await (event, data) in api.events() {
                        guard let self else { return }
                        self.online = true
                        switch event {
                        case "note":
                            if let note = try? JSONDecoder.server.decode(Note.self, from: data) { self.merge([note]) }
                        case "hello":
                            self.ai = (try? JSONDecoder.server.decode(HelloEvent.self, from: data))?.ai
                            await self.pull()
                            await self.flush()
                        case "status":
                            self.ai = try? JSONDecoder.server.decode(AIStatus.self, from: data)
                        default:
                            break
                        }
                    }
                } catch {
                    self?.handleUnauthorized(error)
                }
                guard let self, self.isLoggedIn else { return }
                self.online = false
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func pull() async {
        guard let api, isLoggedIn, !pulling else { return }
        pulling = true
        defer { pulling = false }
        do {
            let page = try await api.get("notes?since=\(rev)", as: NotesPage.self)
            merge(page.notes)
            if page.rev < rev {
                // The server's database was replaced; load everything again.
                rev = 0
                pulling = false
                await pull()
                return
            }
            rev = page.rev
            online = true
            saveCache()
        } catch {
            handleUnauthorized(error)
            online = false
        }
    }

    /// Merges notes from the server. Unsent local edits keep their text and
    /// choices, but still pick up fresh AI results.
    private func merge(_ incoming: [Note]) {
        let pendingIds = Set(outbox.filter { $0.kind == "note" }.map(\.id))
        for var s in incoming {
            if let local = notes[s.id], pendingIds.contains(s.id) || local.editedAt > s.editedAt {
                var next = local
                next.title = s.title
                next.summary = s.summary
                next.aiGroup = s.aiGroup
                next.aiPriority = s.aiPriority
                next.priorityReason = s.priorityReason
                next.tags = s.tags
                next.dueDate = s.dueDate
                next.aiStatus = local.editedAt != s.editedAt ? "pending" : s.aiStatus
                next.aiError = s.aiError
                next.rev = s.rev
                s = next
            }
            notes[s.id] = s
        }
        saveCache()
    }

    func flush() async {
        guard let api, isLoggedIn, !flushing else { return }
        flushing = true
        defer { flushing = false; saveCache() }
        // Photos first, so notes never point at a missing file for long.
        let ordered = outbox.filter { $0.kind == "image" } + outbox.filter { $0.kind == "note" }
        for item in ordered {
            do {
                if item.kind == "image" {
                    let file = Self.imagesFolder.appendingPathComponent(item.id)
                    if let data = try? Data(contentsOf: file) {
                        _ = try await api.request("images/\(item.id)", method: "PUT", body: data, contentType: "image/jpeg")
                    }
                    outbox.removeAll { $0.kind == "image" && $0.id == item.id }
                } else {
                    let json = (item.body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
                    let data = try await api.request("notes/\(item.id)", method: "PUT", json: json)
                    let result = try JSONDecoder.server.decode(SaveResult.self, from: data)
                    // Only clear it if no newer edit was queued meanwhile.
                    if let current = outbox.firstIndex(where: { $0.kind == "note" && $0.id == item.id }),
                       outbox[current].body == item.body {
                        outbox.remove(at: current)
                    }
                    merge([result.note])
                }
                online = true
            } catch {
                handleUnauthorized(error)
                if (error as? APIError)?.status == 0 { online = false }
                return
            }
        }
    }

    // MARK: Editing

    /// Creates or updates a note. `patch` uses the server's field names
    /// (text, images, done, deleted, user_group, user_priority); NSNull clears a value.
    func save(id: String, patch: [String: Any]) {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        var note = notes[id] ?? Note.new(text: "", images: [])
        note.id = id
        let before = note
        if let text = patch["text"] as? String { note.text = text }
        if let images = patch["images"] as? [String] { note.images = images }
        if let done = patch["done"] as? Bool { note.done = done }
        if let deleted = patch["deleted"] as? Bool { note.deleted = deleted }
        if patch.keys.contains("user_group") { note.userGroup = patch["user_group"] as? String }
        if patch.keys.contains("user_priority") { note.userPriority = patch["user_priority"] as? String }
        note.editedAt = max(now, before.editedAt + 1)
        let isNew = notes[id] == nil
        if isNew || note.text != before.text || note.images != before.images { note.aiStatus = "pending" }
        notes[id] = note

        // Merge with an unsent change for the same note.
        var body: [String: Any] = ["created_at": note.createdAt]
        if let i = outbox.firstIndex(where: { $0.kind == "note" && $0.id == id }),
           let old = outbox[i].body.flatMap({ try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] {
            body = old
            outbox.remove(at: i)
        }
        for (k, v) in patch { body[k] = v }
        body["edited_at"] = note.editedAt
        let data = try? JSONSerialization.data(withJSONObject: body)
        outbox.append(OutboxItem(kind: "note", id: id, body: data))
        saveCache()
        Task { await flush() }
    }

    func create(text: String, images: [String]) {
        save(id: UUID().uuidString.lowercased(), patch: ["text": text, "images": images])
    }

    /// Stores a photo on the phone and queues its upload. Returns its file name.
    func addImage(_ image: UIImage) -> String? {
        guard let data = ImageTools.jpeg(image) else { return nil }
        let name = "\(UUID().uuidString.lowercased()).jpg"
        try? data.write(to: Self.imagesFolder.appendingPathComponent(name))
        outbox.append(OutboxItem(kind: "image", id: name, body: nil))
        saveCache()
        Task { await flush() }
        return name
    }

    func reanalyze(_ id: String) async throws {
        await flush()
        guard let api else { return }
        _ = try await api.request("notes/\(id)/reanalyze", method: "POST", json: [:])
    }

    func reorganize() async throws -> ReorganizeResult {
        guard let api else { throw APIError.offline }
        return try JSONDecoder.server.decode(ReorganizeResult.self,
                                             from: try await api.request("reorganize", method: "POST", json: [:]))
    }

    /// Loads a photo: from the phone if it's there, otherwise from the server (then kept on the phone).
    func image(named name: String) async -> UIImage? {
        let file = Self.imagesFolder.appendingPathComponent(name)
        if let img = UIImage(contentsOfFile: file.path) { return img }
        guard let api, let data = try? await api.request("images/\(name)") else { return nil }
        try? data.write(to: file)
        return UIImage(data: data)
    }

    // MARK: Lists

    var visibleNotes: [Note] { notes.values.filter { !$0.deleted } }

    var groupNames: [String] {
        var counts: [String: Int] = [:]
        for n in visibleNotes where !n.done { counts[n.group, default: 0] += 1 }
        return counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map(\.key)
    }

    static func sort(_ a: Note, _ b: Note) -> Bool {
        if a.priority.rank != b.priority.rank { return a.priority.rank < b.priority.rank }
        switch (a.dueDate, b.dueDate) {
        case let (x?, y?) where x != y: return x < y
        case (_?, nil): return true
        case (nil, _?): return false
        default: return a.createdAt > b.createdAt
        }
    }
}
