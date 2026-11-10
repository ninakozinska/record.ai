import SwiftUI

/// "Created … · Edited …" and the note's history: what changed, when and by whom.
struct HistorySection: View {
    @Environment(NoteStore.self) private var store
    let note: Note
    let people: [Person]
    @State private var events: [HistoryEvent]?
    @State private var failed = false
    @State private var open = false

    var body: some View {
        Section {
            Text(timesLine).font(.footnote).foregroundStyle(.secondary)
            DisclosureGroup(isExpanded: $open) {
                if failed {
                    Text(tr("The history needs a connection.")).font(.footnote).foregroundStyle(.secondary)
                } else if let events {
                    if events.isEmpty { Text(tr("No changes yet.")).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(events) { e in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(line(e)).font(.subheadline)
                            Text(when(e.at) + who(e)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    ProgressView()
                }
            } label: {
                Text(tr("🕘 History"))
            }
            .onChange(of: open) { _, isOpen in if isOpen { Task { await load() } } }
        }
    }

    private var timesLine: String {
        var parts = [tr("Created {when}").replacingOccurrences(of: "{when}", with: when(note.createdAt))]
        if note.editedAt - note.createdAt > 60_000 {
            parts.append(tr("Edited {when}").replacingOccurrences(of: "{when}", with: when(note.editedAt)))
        }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            events = try await store.history(note.id)
            failed = false
        } catch {
            failed = true
        }
    }

    private func when(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    }

    private func name(_ id: String?) -> String {
        guard let id else { return tr("someone") }
        if id == store.user?.id { return tr("you") }
        return people.first { $0.id == id }?.name ?? tr("someone")
    }

    private func who(_ e: HistoryEvent) -> String {
        guard let by = e.by else { return "" }
        return " · " + (by.id == store.user?.id ? tr("you") : by.name ?? tr("someone"))
    }

    private func day(_ d: HistoryEvent.Detail) -> String {
        guard let date = d.date else { return "" }
        let parsed = ISO8601DateFormatter().date(from: date + "T12:00:00Z")
        let text = parsed?.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) ?? date
        return d.time.map { "\(text) \($0)" } ?? text
    }

    private func priority(_ p: String?) -> String {
        p.flatMap { Priority(rawValue: $0)?.label } ?? p ?? ""
    }

    private func line(_ e: HistoryEvent) -> String {
        let d = e.detail ?? HistoryEvent.Detail()
        let text = d.text ?? ""
        switch e.kind {
        case "created": return tr("Created")
        case "edited": return tr("Edited")
        case "done": return tr("Marked done")
        case "reopened": return tr("Opened again")
        case "deleted": return tr("Deleted")
        case "restored": return tr("Restored")
        case "date": return d.date == nil ? tr("Date removed") : tr("Date set to {date}").replacingOccurrences(of: "{date}", with: day(d))
        case "group": return tr("Moved to {group}").replacingOccurrences(of: "{group}", with: d.group ?? "")
        case "priority": return tr("Priority set to {priority}").replacingOccurrences(of: "{priority}", with: priority(d.priority))
        case "assigned": return d.to == nil ? tr("No longer for anyone") : tr("Now for {name}").replacingOccurrences(of: "{name}", with: name(d.to))
        case "reminder": return d.minutes == nil ? tr("Reminder removed") : tr("Reminder set")
        case "sorted":
            let s = tr("Sorted by the AI: {group}, {priority}")
                .replacingOccurrences(of: "{group}", with: d.group ?? "Inbox")
                .replacingOccurrences(of: "{priority}", with: priority(d.priority))
            return d.date == nil ? s : s + ", " + day(d)
        case "item_added": return tr("Added \"{text}\"").replacingOccurrences(of: "{text}", with: text)
        case "item_done": return tr("Ticked \"{text}\"").replacingOccurrences(of: "{text}", with: text)
        case "item_reopened": return tr("Unticked \"{text}\"").replacingOccurrences(of: "{text}", with: text)
        case "item_removed": return tr("Removed \"{text}\"").replacingOccurrences(of: "{text}", with: text)
        case "item_edited": return tr("Changed \"{text}\"").replacingOccurrences(of: "{text}", with: text)
        default: return e.kind
        }
    }
}
