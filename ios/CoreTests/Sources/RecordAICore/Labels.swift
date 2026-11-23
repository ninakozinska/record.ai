import Foundation

/// One of the person's labels, like Gmail's: a name and a colour (see /api/labels).
/// (Not "Label": that name is SwiftUI's.)
struct NoteLabel: Codable, Equatable, Hashable {
    var name: String
    var color: String
}

/// The person's labels, whether they may set them (labels are part of Premium),
/// and the colours the server accepts. Same rules as the web app (public/app.js).
struct LabelsState: Codable, Equatable {
    var labels: [NoteLabel] = []
    var allowed: Bool = false
    var colors: [String] = []

    /// A label's colour by name (any case); grey for one that is not in the list any more.
    func color(of name: String) -> String {
        labels.first { $0.name.lowercased() == name.lowercased() }?.color ?? "gray"
    }

    /// The list with a new label at the end (once, whatever its case), in the next colour.
    func adding(_ name: String) -> [NoteLabel] {
        let clean = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        if clean.isEmpty || labels.contains(where: { $0.name.lowercased() == clean.lowercased() }) { return labels }
        let palette = colors.isEmpty ? ["indigo"] : colors
        return labels + [NoteLabel(name: clean, color: palette[labels.count % palette.count])]
    }

    /// The labels to offer in the note editor: mine, then any on the note that are no longer in my list.
    func choices(onNote: [String]) -> [String] {
        let mine = labels.map(\.name)
        return mine + onNote.filter { !mine.contains($0) }
    }
}

enum Labels {
    /// The note's labels with this one added, or taken off.
    static func toggle(_ current: [String], _ name: String) -> [String] {
        current.contains(name) ? current.filter { $0 != name } : current + [name]
    }

    /// A label colour as red, green, blue (0...1): the same palette as the web app's styles.
    static func rgb(_ color: String) -> (Double, Double, Double) {
        let hex: Int
        switch color {
        case "indigo": hex = 0x4338CA
        case "red": hex = 0xB91C1C
        case "orange": hex = 0xC2410C
        case "yellow": hex = 0xA16207
        case "green": hex = 0x15803D
        case "teal": hex = 0x0F766E
        case "blue": hex = 0x1D4ED8
        case "purple": hex = 0x7E22CE
        case "pink": hex = 0xBE185D
        default: hex = 0x6B7280
        }
        return (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
    }
}

/// Searching notes, like the web app: every word must be found; "label:leo" finds notes with that label.
enum NoteSearch {
    /// `fields` are the note's words (text, title, summary, group, tags, list items);
    /// `labels` its labels. "label:school_trip" matches the label "School trip".
    static func matches(fields: [String], labels: [String], query: String) -> Bool {
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if words.isEmpty { return true }
        let lower = labels.map { $0.lowercased() }
        let hay = (fields + lower).joined(separator: " ").lowercased()
        return words.allSatisfy { w in
            if w.hasPrefix("label:") {
                return lower.contains(String(w.dropFirst(6)).replacingOccurrences(of: "_", with: " "))
            }
            return hay.contains(w)
        }
    }
}
