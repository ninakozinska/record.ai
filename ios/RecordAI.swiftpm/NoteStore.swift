import Foundation
import Observation
import UIKit

/// A change waiting to be sent to the server (kept on disk, so nothing is lost offline).
struct OutboxItem: Codable {
    var kind: String          // "note" or "image"
    var id: String            // note id or image file name
    var body: Data?           // JSON object with the changed note fields
}

private struct SyncResult: Codable {
    struct Item: Codable {
        var id: String?
        var status: String
    }
    var rev: Int
    var results: [Item]
    var notes: [Note]
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
    private(set) var providers: [AuthProvider] = []
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
    @ObservationIgnored private var flushAgain = false
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
        providers = state.providers ?? []
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

    /// Where to start "Continue with …", plus the secret that proves later that
    /// this app started it. Only this app ever sees the secret.
    func socialLoginStart(provider: String, invite: String) -> (url: URL, verifier: String)? {
        guard let serverURL else { return nil }
        let verifier = OAuthSecret.make()
        var parts = URLComponents(string: serverURL.absoluteString + "/api/auth/oauth/\(provider)/start")
        parts?.queryItems = [URLQueryItem(name: "app", value: OAuthSecret.challenge(for: verifier))]
        if !invite.isEmpty { parts?.queryItems?.append(URLQueryItem(name: "invite", value: invite)) }
        guard let url = parts?.url else { return nil }
        return (url, verifier)
    }

    /// The sign-in sheet came back to recordai://auth?code=… (or ?error=…).
    func socialLoginFinish(callback: URL, verifier: String) async throws {
        guard let api else { return }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let message = items.first(where: { $0.name == "error" })?.value {
            throw APIError(status: 400, message: message)
        }
        guard let code = items.first(where: { $0.name == "code" })?.value else {
            throw APIError(status: 400, message: "Sign-in didn't finish. Please try again.")
        }
        let result = try await api.post("auth/oauth/exchange", ["code": code, "verifier": verifier], as: AuthResult.self)
        signedIn(result)
    }

    func accountInfo() async throws -> AccountInfo? {
        guard let api else { return nil }
        return try await api.get("auth/me", as: AccountInfo.self)
    }

    func disconnect(provider: String) async throws {
        guard let api else { return }
        _ = try await api.request("auth/identities/\(provider)", method: "DELETE")
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

    /// Emails a link to choose a new password (opens in the browser). Same answer whether the account exists or not.
    func forgotPassword(email: String) async throws {
        guard let api else { throw APIError.offline }
        _ = try await api.request("auth/forgot", method: "POST", json: ["email": email.trimmingCharacters(in: .whitespaces)])
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
                        case "shares":
                            // Something was shared with me, or stopped being shared.
                            await self.pull()
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
            let page = try await api.get("notes?since=\(rev)&items=1&shared=1", as: NotesPage.self)
            merge(page.notes)
            if page.rev < rev {
                // The server's database was replaced: drop the cached copies and load everything again.
                rev = 0
                notes = [:]
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
            if s.revoked == true {
                // No longer shared with me: it (and its items) leave this phone.
                notes[s.id] = nil
                for item in notes.values where item.parentId == s.id { notes[item.id] = nil }
                outbox.removeAll { $0.kind == "note" && $0.id == s.id }
                continue
            }
            // Replies and live updates can arrive out of order; never let an older
            // server state (lower revision) overwrite a newer one.
            if let lr = notes[s.id]?.rev, let sr = s.rev, sr < lr { continue }
            if let local = notes[s.id], pendingIds.contains(s.id) || local.editedAt > s.editedAt {
                var next = local
                next.title = s.title
                next.summary = s.summary
                next.aiGroup = s.aiGroup
                next.aiPriority = s.aiPriority
                next.priorityReason = s.priorityReason
                next.tags = s.tags
                next.dueDate = s.dueDate
                next.dueTime = s.dueTime
                next.aiDueDate = s.aiDueDate
                next.aiDueTime = s.aiDueTime
                next.role = s.role
                next.ownerName = s.ownerName
                next.userId = s.userId
                // Only a change to the text or photos makes the AI work again.
                let contentDiffers = local.text != s.text || local.images != s.images
                next.aiStatus = contentDiffers ? "pending" : s.aiStatus
                next.aiError = s.aiError
                next.rev = s.rev
                next.doneBy = s.doneBy
                s = next
            }
            notes[s.id] = s
        }
        saveCache()
    }

    func flush() async {
        guard let api, isLoggedIn else { return }
        if flushing {
            // An edit made while sending: send it as soon as this round finishes.
            flushAgain = true
            return
        }
        flushing = true
        flushAgain = false
        var sent = false
        defer {
            flushing = false
            saveCache()
            if sent && flushAgain { Task { await flush() } }
        }
        do {
            // Photos first (each with its small preview), so notes never point at a missing file for long.
            for item in outbox where item.kind == "image" {
                let thumb = Self.imagesFolder.appendingPathComponent(item.id + ".thumb")
                if let data = try? Data(contentsOf: thumb) {
                    _ = try await api.request("images/\(item.id)?variant=thumb", method: "PUT", body: data, contentType: "image/jpeg")
                }
                if let data = try? Data(contentsOf: Self.imagesFolder.appendingPathComponent(item.id)) {
                    _ = try await api.request("images/\(item.id)", method: "PUT", body: data, contentType: "image/jpeg")
                }
                outbox.removeAll { $0.kind == "image" && $0.id == item.id }
            }
            // Then every note change in ONE request, which also brings back what changed on the server.
            let notesToSend = outbox.filter { $0.kind == "note" }
            let changes: [[String: Any]] = notesToSend.map { item in
                var body = (item.body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
                body["id"] = item.id
                return body
            }
            let since = rev
            let data = try await api.request("sync", method: "POST", json: ["since": since, "items": true, "shared": true, "changes": changes])
            let result = try JSONDecoder.server.decode(SyncResult.self, from: data)
            for (k, item) in notesToSend.enumerated() where k < result.results.count {
                // Sent (or refused for good): clear it, unless a newer edit was queued meanwhile.
                if let current = outbox.firstIndex(where: { $0.kind == "note" && $0.id == item.id }),
                   outbox[current].body == item.body {
                    outbox.remove(at: current)
                }
            }
            merge(result.notes)
            if since == rev && result.rev >= rev { rev = result.rev }
            online = true
        } catch {
            handleUnauthorized(error)
            if (error as? APIError)?.status == 0 { online = false }
            return
        }
        sent = true
    }

    // MARK: Editing

    /// Creates or updates a note. `patch` uses the server's field names
    /// (text, images, done, deleted, user_group, user_priority, user_due, parent_id); NSNull clears a value.
    /// `send: false` waits, so several changes travel together (call `sendNow()` after).
    func save(id: String, patch: [String: Any], send: Bool = true) {
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
        if patch.keys.contains("user_due") { note.userDue = patch["user_due"] as? String }
        if patch.keys.contains("remind") { note.remind = patch["remind"] as? Int }
        if patch.keys.contains("assigned_to") { note.assignedTo = patch["assigned_to"] as? String }
        if let parent = patch["parent_id"] as? String { note.parentId = parent }
        note.editedAt = max(now, before.editedAt + 1)
        let isNew = notes[id] == nil
        if isNew || note.text != before.text || note.images != before.images { note.aiStatus = "pending" }
        if note.parentId != nil { note.aiStatus = "done" } // list items skip the AI
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
        if send { Task { await flush() } }
    }

    func sendNow() { Task { await flush() } }

    private static func newId() -> String { UUID().uuidString.lowercased() }

    /// A new note. Lines starting with "- ", "* ", "• ", "[ ]" or "☐" become the
    /// items of a checklist; the list and its items reach the server together.
    @discardableResult
    func create(text: String, images: [String]) -> String {
        let (rest, items) = Self.splitList(text)
        let id = Self.newId()
        save(id: id, patch: ["text": items.isEmpty ? text : rest, "images": images], send: false)
        for item in items { addItem(to: id, text: item, send: false) }
        sendNow()
        return id
    }

    func addItem(to listId: String, text: String, send: Bool = true) {
        save(id: Self.newId(), patch: ["text": text, "parent_id": listId], send: send)
    }

    /// Pasted lines: one note with a checklist, or separate notes (each sorted by the AI on its own).
    func createMany(_ lines: [String], together: Bool) {
        if together {
            let listId = Self.newId()
            save(id: listId, patch: ["text": "", "images": [String]()], send: false)
            for line in lines { addItem(to: listId, text: line, send: false) }
        } else {
            for line in lines { save(id: Self.newId(), patch: ["text": line, "images": [String]()], send: false) }
        }
        sendNow()
    }

    func setDone(_ id: String, _ done: Bool) { save(id: id, patch: ["done": done]) }

    /// Sets the date: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM", "" for no date, or nil to let the AI decide.
    func setDue(_ id: String, _ due: String?) { save(id: id, patch: ["user_due": due.map { $0 as Any } ?? NSNull()]) }

    /// Deletes my done notes (not ones shared with me). Returns their ids, for Undo.
    func clearDone(_ ids: [String]) -> [String] {
        let mine = ids.compactMap { notes[$0] }.filter { $0.done && !$0.isShared && $0.parentId == nil }.map(\.id)
        for id in mine { save(id: id, patch: ["deleted": true], send: false) }
        sendNow()
        return mine
    }

    func undelete(_ ids: [String]) {
        for id in ids { save(id: id, patch: ["deleted": false], send: false) }
        sendNow()
    }

    private static let itemLine = try! NSRegularExpression(pattern: #"^\s*(?:[-*•]|\[ ?\]|☐)\s+(.+)$"#)
    private static let bullet = try! NSRegularExpression(pattern: #"^\s*(?:[-*•·–]|\d+[.)]|\[[ xX]?\]|[☐☑✓✔])\s*"#)

    /// The note's own text and its checklist items (same rules as the web app).
    static func splitList(_ text: String) -> (String, [String]) {
        var rest: [String] = []
        var items: [String] = []
        for line in text.components(separatedBy: "\n") {
            let range = NSRange(line.startIndex..., in: line)
            if let m = itemLine.firstMatch(in: line, range: range), let r = Range(m.range(at: 1), in: line) {
                items.append(line[r].trimmingCharacters(in: .whitespaces))
            } else {
                rest.append(line)
            }
        }
        return (rest.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), items)
    }

    /// Lines of pasted text without bullets; nil unless there are at least two.
    static func pastedLines(_ text: String) -> [String]? {
        let lines = text.components(separatedBy: .newlines).map { line in
            bullet.stringByReplacingMatches(in: line, range: NSRange(line.startIndex..., in: line), withTemplate: "")
                .trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
        return lines.count > 1 ? lines : nil
    }

    // MARK: Sharing, Premium, account

    func shares() async throws -> Shares {
        guard let api else { throw APIError.offline }
        return try await api.get("shares", as: Shares.self)
    }

    /// kind: "note" (by id) or "group" (by name); role: "edit" or "view".
    func share(kind: String, target: String, email: String, role: String) async throws {
        guard let api else { throw APIError.offline }
        _ = try await api.request("shares", method: "POST", json: ["kind": kind, "target": target, "email": email, "role": role])
    }

    func setShareRole(_ id: String, role: String) async throws {
        guard let api else { throw APIError.offline }
        _ = try await api.request("shares/\(id)", method: "PATCH", json: ["role": role])
    }

    /// Stop sharing (the owner), or leave something shared with me.
    func unshare(_ id: String) async throws {
        guard let api else { throw APIError.offline }
        _ = try await api.request("shares/\(id)", method: "DELETE")
        await pull()
    }

    /// Leaves a note shared with me (it disappears from my devices).
    func leave(_ note: Note) async throws {
        let withMe = try await shares().withMe
        let group = note.userGroup ?? note.aiGroup ?? ""
        let share = withMe.first { $0.kind == "note" && $0.target == note.id }
            ?? withMe.first { $0.kind == "group" && $0.owner?.id == note.userId && $0.target.lowercased() == group.lowercased() }
        if let share { try await unshare(share.id) }
    }

    /// Groups moved between Work and Family; empty when offline (names decide then).
    func worlds() async -> [String: String] {
        guard let api else { return [:] }
        return (try? await api.get("groups/worlds", as: WorldChoices.self).chosen) ?? [:]
    }

    func plan() async throws -> Plan {
        guard let api else { throw APIError.offline }
        return try await api.get("plan", as: Plan.self)
    }

    func backups() async throws -> [Backup] {
        guard let api else { throw APIError.offline }
        return try await api.get("backups", as: BackupList.self).backups
    }

    func backupNow() async throws {
        guard let api else { throw APIError.offline }
        _ = try await api.request("backups", method: "POST", json: [:])
    }

    func restore(_ id: String) async throws {
        guard let api else { throw APIError.offline }
        _ = try await api.request("backups/\(id)/restore", method: "POST", json: [:])
        await pull()
    }

    /// Deletes the account on the server (typing its email confirms), then everything on the phone.
    func deleteAccount(email: String) async throws {
        guard let api else { throw APIError.offline }
        _ = try await api.request("account/delete", method: "POST", json: ["email": email.trimmingCharacters(in: .whitespaces)])
        stopLive()
        setToken(nil)
        setUser(nil)
        wipeLocalData()
        try? await refreshAuthState()
    }

    /// Stores a photo on the phone and queues its upload. Returns its file name.
    func addImage(_ image: UIImage) -> String? {
        guard let data = ImageTools.jpeg(image) else { return nil }
        let name = "\(UUID().uuidString.lowercased()).jpg"
        try? data.write(to: Self.imagesFolder.appendingPathComponent(name))
        if let thumb = ImageTools.jpeg(image, maxSide: 320, quality: 0.7) {
            try? thumb.write(to: Self.imagesFolder.appendingPathComponent(name + ".thumb"))
        }
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

    /// The people tasks can be for: me, and everyone I share with.
    func people() async -> People {
        guard let api, let data = try? await api.request("people") else { return People(people: [], family: false) }
        return (try? JSONDecoder.server.decode(People.self, from: data)) ?? People(people: [], family: false)
    }

    /// "Turn into tasks": sends the note, asks the server for its tasks, then fetches them.
    func extractTasks(_ id: String) async throws -> Int {
        await flush()
        guard let api else { throw APIError.offline }
        let result = try JSONDecoder.server.decode(TasksResult.self, from: try await api.request("notes/\(id)/tasks", method: "POST", json: [:]))
        await flush()
        return result.ids.count
    }

    func reorganize() async throws -> ReorganizeResult {
        guard let api else { throw APIError.offline }
        return try JSONDecoder.server.decode(ReorganizeResult.self,
                                             from: try await api.request("reorganize", method: "POST", json: [:]))
    }

    /// Decoded photos kept in memory, so scrolling doesn't decode them again.
    @ObservationIgnored private let imageCache = NSCache<NSString, UIImage>()

    /// Loads a photo, or its small preview (`thumb`): from memory, from the
    /// phone, or from the server (then kept on the phone).
    func image(named name: String, thumb: Bool = false) async -> UIImage? {
        let key = (thumb ? name + ".thumb" : name) as NSString
        if let cached = imageCache.object(forKey: key) { return cached }
        let file = Self.imagesFolder.appendingPathComponent(key as String)
        var loaded = UIImage(contentsOfFile: file.path)
        let path = thumb ? "images/\(name)?variant=thumb" : "images/\(name)"
        if loaded == nil, let api {
            let data = try? await api.request(path)
            if let data {
                try? data.write(to: file)
                loaded = UIImage(data: data)
            }
        }
        if loaded == nil && thumb {
            let full = await image(named: name, thumb: false)
            return full
        }
        if let loaded { imageCache.setObject(loaded, forKey: key) }
        return loaded
    }

    // MARK: Lists

    /// Notes and lists (not the items inside lists).
    var visibleNotes: [Note] { notes.values.filter { !$0.deleted && $0.parentId == nil } }

    /// A list's items: open ones first, most urgent first, then in the order they were added.
    func items(of listId: String) -> [Note] {
        notes.values.filter { $0.parentId == listId && !$0.deleted }.sorted { a, b in
            if a.done != b.done { return !a.done }
            if a.priority.rank != b.priority.rank { return a.priority.rank < b.priority.rank }
            return a.createdAt < b.createdAt
        }
    }

    var groupNames: [String] {
        var counts: [String: Int] = [:]
        for n in visibleNotes where !n.done { counts[n.group, default: 0] += 1 }
        return counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map(\.key)
    }

    static func sort(_ a: Note, _ b: Note) -> Bool {
        if a.priority.rank != b.priority.rank { return a.priority.rank < b.priority.rank }
        switch (a.dueDay.map { $0 + (a.dueHour ?? "") }, b.dueDay.map { $0 + (b.dueHour ?? "") }) {
        case let (x?, y?) where x != y: return x < y
        case (_?, nil): return true
        case (nil, _?): return false
        default: return a.createdAt > b.createdAt
        }
    }
}
