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

    var group: String {
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

    var due: Date? {
        guard let dueDate else { return nil }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.date(from: dueDate)
    }

    static func new(text: String, images: [String]) -> Note {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        return Note(id: UUID().uuidString.lowercased(), text: text, images: images, done: false, deleted: false,
                    createdAt: now, editedAt: now, aiStatus: "pending")
    }
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
