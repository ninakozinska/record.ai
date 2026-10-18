import SwiftUI

private struct EditTarget: Identifiable { let id: String }

/// The main screen: write a note at the bottom, notes sorted by priority or group above.
struct NotesView: View {
    @Environment(NoteStore.self) private var store
    @AppStorage("view") private var viewMode = "priority"
    @State private var query = ""
    @State private var group: String?
    @State private var showDone = false
    @State private var editing: EditTarget?
    @State private var showAccount = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                if !store.groupNames.isEmpty {
                    Section { groupChips }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
                if !store.isAIEnabled {
                    Section {
                        Label("AI sorting is off on your server. Notes are saved and synced but not sorted.", systemImage: "sparkles")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(sections, id: \.title) { section in
                    Section {
                        ForEach(section.notes) { note in
                            NoteRow(note: note, showGroup: viewMode == "priority")
                                .contentShape(Rectangle())
                                .onTapGesture { editing = EditTarget(id: note.id) }
                                .swipeActions(edge: .leading) {
                                    Button { store.save(id: note.id, patch: ["done": !note.done]) } label: {
                                        Label(note.done ? "Not done" : "Done", systemImage: "checkmark")
                                    }
                                    .tint(.green)
                                }
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) { store.save(id: note.id, patch: ["deleted": true]) } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                        }
                    } header: {
                        Text("\(section.title)  \(section.notes.count)")
                            .foregroundStyle(section.color)
                    }
                }
                if open.isEmpty {
                    Section {
                        Text(store.visibleNotes.isEmpty
                             ? "No notes yet. Type, dictate 🎤 or take a photo 📷 below. AI will title, prioritize and group them for you."
                             : "Nothing here. 🎉")
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                            .padding(.vertical, 24)
                    }
                }
                if !done.isEmpty {
                    Section {
                        Button(showDone ? "Hide done (\(done.count))" : "Show done (\(done.count))") { showDone.toggle() }
                        if showDone {
                            ForEach(done) { note in
                                NoteRow(note: note, showGroup: true)
                                    .contentShape(Rectangle())
                                    .onTapGesture { editing = EditTarget(id: note.id) }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: "Search notes")
            .refreshable {
                await store.pull()
                await store.flush()
            }
            .navigationTitle("record.ai")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { syncDot }
                ToolbarItem(placement: .principal) {
                    Picker("View", selection: $viewMode) {
                        Text("Priority").tag("priority")
                        Text("Groups").tag("groups")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if store.isAIEnabled {
                            Button { reorganize() } label: { Label("Reorganize with AI", systemImage: "sparkles") }
                        }
                        Button { showAccount = true } label: { Label("Account", systemImage: "person.crop.circle") }
                    } label: {
                        Text(store.user?.initials ?? "?")
                            .font(.footnote.bold())
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Color.indigo))
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { ComposerView() }
            .sheet(item: $editing) { target in NoteDetailView(noteId: target.id) }
            .sheet(isPresented: $showAccount) { AccountView() }
            .overlay(alignment: .top) {
                if let message {
                    Text(message)
                        .font(.footnote)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
        }
    }

    // MARK: Pieces

    private var syncDot: some View {
        Circle()
            .fill(store.online ? (store.unsent > 0 ? Color.orange : Color.green) : Color.red)
            .frame(width: 9, height: 9)
            .accessibilityLabel(store.online ? (store.unsent > 0 ? "Syncing" : "Synced") : "Offline")
    }

    private var groupChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", selected: group == nil) { group = nil }
                ForEach(store.groupNames, id: \.self) { name in
                    chip(name, selected: group == name) { group = name }
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
        }
    }

    private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .foregroundStyle(selected ? Color(.systemBackground) : Color.primary)
                .background(Capsule().fill(selected ? Color.primary : Color(.secondarySystemGroupedBackground)))
        }
        .buttonStyle(.plain)
    }

    // MARK: Data

    private struct NoteSection {
        var title: String
        var color: Color
        var notes: [Note]
    }

    private var filtered: [Note] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        return store.visibleNotes.filter { n in
            if let group, n.group != group { return false }
            if words.isEmpty { return true }
            let hay = ([n.text, n.title ?? "", n.summary ?? "", n.group] + (n.tags ?? [])).joined(separator: " ").lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    private var open: [Note] { filtered.filter { !$0.done }.sorted(by: NoteStore.sort) }
    private var done: [Note] { filtered.filter(\.done).sorted { $0.editedAt > $1.editedAt } }

    private var sections: [NoteSection] {
        if viewMode == "groups" {
            let names = store.groupNames.filter { name in open.contains { $0.group == name } }
            return names.map { name in NoteSection(title: name, color: .secondary, notes: open.filter { $0.group == name }) }
        }
        return Priority.allCases.compactMap { p in
            let notes = open.filter { $0.priority == p }
            return notes.isEmpty ? nil : NoteSection(title: p.label, color: p == .low || p == .normal ? .secondary : p.color, notes: notes)
        }
    }

    private func reorganize() {
        Task {
            show("✨ Reorganizing…")
            do {
                let r = try await store.reorganize()
                show(r.skipped == true ? "Already reorganizing" : "Reorganized: \(r.updated ?? 0) note(s) moved")
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func show(_ text: String) {
        withAnimation { message = text }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation { if message == text { message = nil } }
        }
    }
}

/// One note in the list.
struct NoteRow: View {
    @Environment(NoteStore.self) private var store
    var note: Note
    var showGroup: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                store.save(id: note.id, patch: ["done": !note.done])
            } label: {
                Image(systemName: note.done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(note.done ? Color.indigo : Color.secondary)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(note.displayTitle)
                        .font(.headline)
                        .strikethrough(note.done)
                    if note.aiStatus == "pending" {
                        Image(systemName: "sparkles").foregroundStyle(.indigo).font(.caption)
                    } else if note.aiStatus == "error" {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow).font(.caption)
                    }
                }
                let preview = note.preview.trimmingCharacters(in: .whitespacesAndNewlines)
                if !preview.isEmpty {
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if !note.images.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(note.images, id: \.self) { name in
                                NoteImage(name: name)
                                    .frame(width: 84, height: 84)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                }
                HStack(spacing: 8) {
                    Text(note.priority.label + (note.userPriority != nil ? " 📌" : ""))
                        .font(.caption.bold())
                        .foregroundStyle(note.priority.color)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(note.priority.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
                    if showGroup {
                        Text(note.group + (note.userGroup != nil ? " 📌" : ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let due = note.due {
                        Text(dueLabel(due))
                            .font(.caption)
                            .foregroundStyle(due < Date().addingTimeInterval(86400 * 2) ? Color.red : Color.orange)
                    }
                    Spacer()
                    Text(note.createdDate, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .leading) {
            Rectangle().fill(note.priority.color).frame(width: 3).offset(x: -16)
        }
        .opacity(note.done ? 0.6 : 1)
    }

    private func dueLabel(_ date: Date) -> String {
        let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: date).day ?? 0
        switch days {
        case ..<0: return "overdue \(-days)d"
        case 0: return "due today"
        case 1: return "due tomorrow"
        case 2..<7: return "due in \(days)d"
        default: return "due \(note.dueDate ?? "")"
        }
    }
}
