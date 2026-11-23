import SwiftUI

/// A label as a chip: "🏷 Leo" in its colour; dimmed when it is a choice not on the note.
struct LabelChip: View {
    let name: String
    let color: String
    let on: Bool
    var action: () -> Void = {}

    var body: some View {
        let (r, g, b) = Labels.rgb(color)
        let tint = Color(red: r, green: g, blue: b)
        Button(action: action) {
            Text("🏷 " + name)
                .font(.caption.weight(on ? .semibold : .regular))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .foregroundStyle(on ? tint : Color.secondary)
                .background(Capsule().fill(on ? tint.opacity(0.14) : Color.clear))
                .overlay(Capsule().stroke(on ? tint.opacity(0.35) : Color.secondary.opacity(0.4)))
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(name)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// "🎒 Which child?" under a school note the AI could not place: one tap moves it.
struct WhichChildRow: View {
    @Environment(NoteStore.self) private var store
    let note: Note

    var body: some View {
        let kids = Worlds.childChoices(group: note.group, userGroup: note.userGroup, done: note.done,
                                       shared: note.isShared, myGroups: store.myGroups)
        if !kids.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Text(tr("🎒 Which child?")).font(.caption).foregroundStyle(.secondary)
                    ForEach(kids, id: \.self) { g in
                        Button(Worlds.childName(g)) { store.save(id: note.id, patch: ["user_group": g]) }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    Button(tr("All children")) { store.save(id: note.id, patch: ["user_group": "School"]) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
    }
}

/// The world a group is in, as people read it.
func worldLabel(_ world: String?) -> String {
    switch world {
    case Worlds.work: return tr("💼 Work")
    case Worlds.family: return tr("🏡 Family")
    case Worlds.school: return tr("🎒 School")
    default: return tr("All worlds")
    }
}

/// "Groceries" is now in 🏡 Family.
func worldMoved(_ group: String, _ world: String) -> String {
    tr("\"{group}\" is now in {world}")
        .replacingOccurrences(of: "{group}", with: group)
        .replacingOccurrences(of: "{world}", with: worldLabel(world.isEmpty ? nil : world))
}

/// Suggested to-dos: the AI proposes, the person adds or dismisses each one.
struct SuggestionsView: View {
    @Environment(NoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?
    @State private var editing: Suggestion?
    @State private var editedTitle = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(tr("To-dos the AI found in your meetings, notes and AI chats. Nothing is added until you add it."))
                        .font(.footnote).foregroundStyle(.secondary)
                    if let message { Text(message).font(.footnote).foregroundStyle(.red) }
                }
                Section {
                    if store.suggestions.isEmpty {
                        Text(tr("Nothing to review right now.")).foregroundStyle(.secondary)
                    }
                    ForEach(store.suggestions) { s in
                        VStack(alignment: .leading, spacing: 6) {
                            Text((s.top == true ? "⭐ " : "") + s.title).bold()
                            Text(details(s)).font(.footnote).foregroundStyle(.secondary)
                            HStack(spacing: 16) {
                                Button(tr("Add")) { decide(s, add: true) }
                                Button(tr("Edit and add")) { editedTitle = s.title; editing = s }
                                Button(tr("Dismiss")) { decide(s, add: false) }.foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)
                            .font(.subheadline)
                        }
                        .padding(.vertical, 4)
                    }
                }
                Section {
                    Button(tr("✨ Suggest now")) {
                        busy = true
                        Task {
                            do { try await store.suggestNow() } catch { message = error.localizedDescription }
                            busy = false
                        }
                    }
                    .disabled(busy)
                }
            }
            .navigationTitle(tr("✨ Suggested"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("Done")) { dismiss() } } }
            .alert(tr("Edit the to-do"), isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                TextField(tr("Edit the to-do"), text: $editedTitle)
                Button(tr("Add")) {
                    let title = editedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let s = editing, !title.isEmpty { decide(s, add: true, title: title) }
                }
                Button(tr("Cancel"), role: .cancel) {}
            }
        }
    }

    private func details(_ s: Suggestion) -> String {
        var parts: [String] = []
        if let d = s.dueDate { parts.append("📅 " + d + (s.dueTime.map { " · " + $0 } ?? "")) }
        parts.append(tr("From:") + " " + (s.sourceLabel ?? tr("your notes")) + (s.reason.map { " · " + $0 } ?? ""))
        return parts.joined(separator: "  ")
    }

    private func decide(_ s: Suggestion, add: Bool, title: String? = nil) {
        Task {
            do {
                try await store.decideSuggestion(s.id, add: add, title: title)
                message = nil
            } catch {
                message = error.localizedDescription
            }
        }
    }
}

/// "Send feedback": a few words to the people who make SortMemo.
struct FeedbackView: View {
    @Environment(NoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var message: String?
    @State private var sent = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(tr("What would make SortMemo better for you? Anything goes: ideas, problems, wishes."), text: $text, axis: .vertical)
                        .lineLimit(4...10)
                } footer: {
                    if let message { Text(message).foregroundStyle(sent ? Color.green : Color.red) }
                }
            }
            .navigationTitle(tr("💬 Send feedback"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(tr("Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(tr("Send")) {
                        Task {
                            do {
                                try await store.sendFeedback(text)
                                sent = true
                                message = tr("Thank you! Nina reads every message.")
                                text = ""
                            } catch {
                                sent = false
                                message = error.localizedDescription
                            }
                        }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

/// Privacy, terms and help on the SortMemo website (they open in the browser).
struct LegalLinks: View {
    let server: URL?

    var body: some View {
        let base = (server ?? API.defaultServer).absoluteString
        HStack(spacing: 16) {
            if let url = URL(string: base + "/legal/privacy.html") { Link(tr("Privacy"), destination: url) }
            if let url = URL(string: base + "/legal/terms.html") { Link(tr("Terms"), destination: url) }
            if let url = URL(string: base + "/legal/support.html") { Link(tr("Help"), destination: url) }
        }
        .font(.footnote)
    }
}
