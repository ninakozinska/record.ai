import Foundation
import SwiftUI

enum Priority: String, Codable, CaseIterable, Identifiable {
    case urgent, high, normal, low

    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var rank: Int { Priority.allCases.firstIndex(of: self) ?? 2 }

    var color: Color {
        switch self {
        case .urgent: return .red
        case .high: return .orange
        case .normal: return .blue
        case .low: return .gray
        }
    }
}

/// A note as the server sends it. Field names match the server's JSON
/// (decoded with `.convertFromSnakeCase`).
struct Note: Codable, Identifiable, Equatable {
    var id: String
    var text: String
    var images: [String]
    var done: Bool
    var deleted: Bool
    var createdAt: Double        // milliseconds since 1970
    var editedAt: Double
    var userGroup: String?
    var userPriority: String?
    var title: String?
    var summary: String?
    var aiGroup: String?
    var aiPriority: String?
    var priorityReason: String?
    var tags: [String]?
    var dueDate: String?
    var aiStatus: String?
    var aiError: String?
    var rev: Int?
    var dueTime: String?
    /// The person's date: nil = the AI decides, "" = no date, "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".
    var userDue: String?
    var aiDueDate: String?
    var aiDueTime: String?
    /// A list item: the id of its list. Items go one level deep.
    var parentId: String?
    var userId: String?
    /// Set on notes shared with me: "edit" or "view".
    var role: String?
    var ownerName: String?
    /// I can no longer see this note: remove it from the phone.
    var revoked: Bool?

    /// Shared with me by someone else.
    var isShared: Bool { role != nil }
    var canEdit: Bool { role != "view" }

    var group: String {
        if role != nil { return Note.sharedGroup }
        if let g = userGroup, !g.isEmpty { return g }
        if let g = aiGroup, !g.isEmpty { return g }
        return "Inbox"
    }

    var priority: Priority {
        Priority(rawValue: userPriority ?? aiPriority ?? "normal") ?? .normal
    }

    var displayTitle: String {
        if let t = title, !t.isEmpty { return t }
        let first = text.split(separator: "\n").first.map(String.init) ?? ""
        if !first.isEmpty { return String(first.prefix(80)) }
        return images.isEmpty ? "Untitled" : "Photo"
    }

    /// Body text shown under the title (skips the first line when it is the title).
    var preview: String {
        if title != nil { return text }
        return text.split(separator: "\n", omittingEmptySubsequences: false).dropFirst().joined(separator: "\n")
    }

    var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }

    static let sharedGroup = "Shared with me"

    /// The date shown ("YYYY-MM-DD"): the person's if they chose one (or chose none), else the AI's.
    var dueDay: String? {
        if let userDue { return userDue.isEmpty ? nil : String(userDue.prefix(10)) }
        return aiDueDate ?? dueDate
    }

    /// The time shown ("HH:MM"), if any.
    var dueHour: String? {
        if let userDue { return userDue.count >= 16 ? String(userDue.dropFirst(11).prefix(5)) : nil }
        return aiDueTime ?? dueTime
    }

    var due: Date? {
        guard let dueDay else { return nil }
        let f = DateFormatter()
        f.dateFormat = dueHour == nil ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm"
        f.timeZone = .current
        return f.date(from: dueHour.map { "\(dueDay) \($0)" } ?? dueDay)
    }

    static func new(text: String, images: [String]) -> Note {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        return Note(id: UUID().uuidString.lowercased(), text: text, images: images, done: false, deleted: false,
                    createdAt: now, editedAt: now, aiStatus: "pending")
    }
}

extension Note {
    enum CodingKeys: String, CodingKey {
        case id, text, images, done, deleted, createdAt, editedAt, userGroup, userPriority, title, summary
        case aiGroup, aiPriority, priorityReason, tags, dueDate, aiStatus, aiError, rev
        case dueTime, userDue, aiDueDate, aiDueTime, parentId, userId, role, ownerName, revoked
    }

    /// Tolerant: a "no longer shared" marker from the server has only id, rev and the flags.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        images = try c.decodeIfPresent([String].self, forKey: .images) ?? []
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        editedAt = try c.decodeIfPresent(Double.self, forKey: .editedAt) ?? 0
        userGroup = try c.decodeIfPresent(String.self, forKey: .userGroup)
        userPriority = try c.decodeIfPresent(String.self, forKey: .userPriority)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        aiGroup = try c.decodeIfPresent(String.self, forKey: .aiGroup)
        aiPriority = try c.decodeIfPresent(String.self, forKey: .aiPriority)
        priorityReason = try c.decodeIfPresent(String.self, forKey: .priorityReason)
        tags = try c.decodeIfPresent([String].self, forKey: .tags)
        dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate)
        aiStatus = try c.decodeIfPresent(String.self, forKey: .aiStatus)
        aiError = try c.decodeIfPresent(String.self, forKey: .aiError)
        rev = try c.decodeIfPresent(Int.self, forKey: .rev)
        dueTime = try c.decodeIfPresent(String.self, forKey: .dueTime)
        userDue = try c.decodeIfPresent(String.self, forKey: .userDue)
        aiDueDate = try c.decodeIfPresent(String.self, forKey: .aiDueDate)
        aiDueTime = try c.decodeIfPresent(String.self, forKey: .aiDueTime)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
        role = try c.decodeIfPresent(String.self, forKey: .role)
        ownerName = try c.decodeIfPresent(String.self, forKey: .ownerName)
        revoked = try c.decodeIfPresent(Bool.self, forKey: .revoked)
    }
}

/// A share I made (`mine`), or one made with me (`withMe`, with its owner).
struct Share: Codable, Identifiable {
    var id: String
    var kind: String          // "note" or "group"
    var target: String        // note id or group name
    var role: String          // "edit" or "view"
    var email: String?
    var name: String?
    var owner: User?
}

struct Shares: Codable {
    var mine: [Share]
    var withMe: [Share]
}

struct Plan: Codable {
    var plan: String
    var premium: Bool
}

struct Backup: Codable, Identifiable {
    var id: String
    var kind: String          // "daily", "manual" or "before-restore"
    var createdAt: Double
    var notes: Int
}

struct BackupList: Codable {
    var backups: [Backup]
}

struct User: Codable, Equatable {
    var id: String
    var name: String
    var email: String

    var initials: String {
        name.split(separator: " ").prefix(2).compactMap { $0.first.map { String($0).uppercased() } }.joined()
    }
}

struct SignupPolicy: Codable {
    var open: Bool
    var needsCode: Bool
    var firstAccount: Bool
}

struct AuthState: Codable {
    var user: User?
    var signup: SignupPolicy
    /// "Continue with Google / Apple / …" options set up on the server.
    var providers: [AuthProvider]?
}

struct AuthProvider: Codable, Identifiable, Equatable {
    var id: String
    var name: String
}

/// What the account screen shows: how this account can log in.
struct AccountInfo: Codable {
    struct Identity: Codable, Identifiable {
        var provider: String
        var name: String
        var email: String?
        var id: String { provider }
    }
    var hasPassword: Bool
    var identities: [Identity]
}

struct AuthResult: Codable {
    var token: String
    var user: User
}

struct NotesPage: Codable {
    var rev: Int
    var notes: [Note]
}

struct SaveResult: Codable {
    var note: Note
    var stale: Bool
}

struct AIStatus: Codable, Equatable {
    var enabled: Bool
    var provider: String?
    var model: String?
    var reorganizing: Bool?
}

struct ReorganizeResult: Codable {
    var updated: Int?
    var skipped: Bool?
}

extension JSONDecoder {
    static let server: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}

extension JSONEncoder {
    static let cache: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()
}
