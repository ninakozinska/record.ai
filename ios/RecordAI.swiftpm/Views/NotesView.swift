import SwiftUI

private struct EditTarget: Identifiable { let id: String }

/// The main screen: write a note at the bottom, notes sorted by priority or group above.
struct NotesView: View {
    @Environment(NoteStore.self) private var store
    @AppStorage("view") private var viewMode = "priority"
    @State private var query = ""
    @State private var group: String?
    @AppStorage("world") private var world = Worlds.all
    @State private var chosenWorlds: [String: String] = [:]
    @State private var showDone = false
    @State private var editing: EditTarget?
    @State private var showAccount = false
    @State private var message: String?
    @State private var undo: (() -> Void)?
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker(tr("World"), selection: $world) {
                        Text(tr("All")).tag(Worlds.all)
                        Text(tr("💼 Work")).tag(Worlds.work)
                        Text(tr("🏡 Family")).tag(Worlds.family)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: world) { _, _ in group = nil }
                }
                .listRowBackground(Color.clear)
                if !groupNames.isEmpty {
                    Section { groupChips }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
                if !store.isAIEnabled {
                    Section {
                        Label(tr("AI sorting is off on your server. Notes are saved and synced but not sorted."), systemImage: "sparkles")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(sections, id: \.title) { section in
                    Section {
                        ForEach(section.notes) { note in
                            NoteRow(note: note, showGroup: viewMode == "priority") { markDone(note) }
                                .contentShape(Rectangle())
                                .onTapGesture { editing = EditTarget(id: note.id) }
                                .swipeActions(edge: .trailing) {
                                    if !note.isShared {
                                        Button(role: .destructive) {
                                            store.save(id: note.id, patch: ["deleted": true])
                                            show(tr("Note deleted")) { store.save(id: note.id, patch: ["deleted": false]) }
                                        } label: {
                                            Label(tr("Delete"), systemImage: "trash")
                                        }
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
                             ? tr("No notes yet. Type, dictate 🎤 or take a photo 📷 below. AI will title, prioritize and group them for you.")
                             : tr("Nothing here. 🎉"))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                            .padding(.vertical, 24)
                    }
                }
                if !done.isEmpty {
                    Section {
                        HStack {
                            Button(showDone ? "Hide done (\(done.count))" : "Show done (\(done.count))") { showDone.toggle() }
                                .buttonStyle(.borderless)
                            Spacer()
                            if showDone && done.contains(where: { !$0.isShared }) {
                                Button(tr("Clear done"), role: .destructive) { confirmClear = true }
                                    .buttonStyle(.borderless)
                            }
                        }
                        if showDone {
                            ForEach(done) { note in
                                NoteRow(note: note, showGroup: true) { markDone(note) }
                                    .contentShape(Rectangle())
                                    .onTapGesture { editing = EditTarget(id: note.id) }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: tr("Search notes"))
            .task(id: store.user?.id) { chosenWorlds = await store.worlds() }
            .refreshable {
                chosenWorlds = await store.worlds()
                await store.pull()
                await store.flush()
            }
            .navigationTitle("record.ai")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { syncDot }
                ToolbarItem(placement: .principal) {
                    Picker(tr("View"), selection: $viewMode) {
                        Text(tr("Priority")).tag("priority")
                        Text(tr("Groups")).tag("groups")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if store.isAIEnabled {
                            Button { reorganize() } label: { Label(tr("Reorganize with AI"), systemImage: "sparkles") }
                        }
                        Button { showAccount = true } label: { Label(tr("Account"), systemImage: "person.crop.circle") }
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
                    HStack(spacing: 12) {
                        Text(message).font(.footnote)
                        if let undo {
                            Button(tr("Undo")) {
                                undo()
                                withAnimation { self.message = nil; self.undo = nil }
                            }
                            .font(.footnote.bold())
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .confirmationDialog(clearQuestion, isPresented: $confirmClear, titleVisibility: .visible) {
                Button(tr("Delete"), role: .destructive) {
                    let removed = store.clearDone(done.map(\.id))
                    show("\(removed.count) done note\(removed.count == 1 ? "" : "s") deleted") { store.undelete(removed) }
                }
            } message: {
                Text(tr("You can undo this for a few seconds."))
            }
        }
    }

    // MARK: Pieces

    private var syncDot: some View {
        Circle()
            .fill(store.online ? (store.unsent > 0 ? Color.orange : Color.green) : Color.red)
            .frame(width: 9, height: 9)
            .accessibilityLabel(store.online ? (store.unsent > 0 ? tr("Syncing") : tr("Synced")) : tr("Offline"))
    }

    private var groupChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(tr("All"), selected: group == nil) { group = nil }
                ForEach(groupNames, id: \.self) { name in
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

    private var groupNames: [String] {
        store.groupNames.filter { Worlds.shows($0, in: world, chosen: chosenWorlds) }
    }

    private var filtered: [Note] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        return store.visibleNotes.filter { n in
            if !Worlds.shows(n.group, in: world, chosen: chosenWorlds) { return false }
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
            let names = groupNames.filter { name in open.contains { $0.group == name } }
            return names.map { name in NoteSection(title: name, color: .secondary, notes: open.filter { $0.group == name }) }
        }
        return Priority.allCases.compactMap { p in
            let notes = open.filter { $0.priority == p }
            return notes.isEmpty ? nil : NoteSection(title: p.label, color: p == .low || p == .normal ? .secondary : p.color, notes: notes)
        }
    }

    private func reorganize() {
        Task {
            show(tr("✨ Reorganizing…"))
            do {
                let r = try await store.reorganize()
                show(r.skipped == true ? tr("Already reorganizing") : "Reorganized: \(r.updated ?? 0) note(s) moved")
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private var clearQuestion: String {
        let n = done.filter { !$0.isShared }.count
        return "Delete \(n) done note\(n == 1 ? "" : "s")?"
    }

    private func markDone(_ note: Note) {
        store.setDone(note.id, !note.done)
        show(note.done ? tr("Back to open notes") : tr("Marked done")) { store.setDone(note.id, note.done) }
    }

    /// A short message at the top; with `undo`, an Undo button for a few seconds.
    private func show(_ text: String, undo: (() -> Void)? = nil) {
        withAnimation {
            message = text
            self.undo = undo
        }
        Task {
            try? await Task.sleep(for: .seconds(undo == nil ? 3 : 5))
            withAnimation { if message == text { message = nil; self.undo = nil } }
        }
    }
}

/// One note in the list.
struct NoteRow: View {
    @Environment(NoteStore.self) private var store
    var note: Note
    var showGroup: Bool
    var onDone: () -> Void = {}

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
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
                let items = store.items(of: note.id)
                if !items.isEmpty {
                    let open = items.filter { !$0.done }
                    Text("☑ \(items.count - open.count)/\(items.count)").font(.caption).foregroundStyle(.secondary)
                    ForEach(open.prefix(4)) { item in
                        Text("☐ " + item.text).font(.subheadline).lineLimit(1)
                    }
                    if open.count > 4 { Text("+ \(open.count - 4) more").font(.caption).foregroundStyle(.secondary) }
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
                    if note.isShared {
                        Text("Shared by \(note.ownerName ?? "someone")" + (note.canEdit ? "" : tr(" · view only")))
                            .font(.caption)
                            .foregroundStyle(.indigo)
                    } else if showGroup {
                        Text(note.group + (note.userGroup != nil ? " 📌" : ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let shown = dueText(note) {
                        Text(shown.0)
                            .font(.caption.bold())
                            .foregroundStyle(shown.1 ? Color.red : Color.secondary)
                    }
                    Spacer()
                    if note.canEdit {
                        Button(action: onDone) {
                            Text(note.done ? tr("↺ Reopen") : tr("✓ Done"))
                                .font(.caption.bold())
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(Capsule().stroke(Color.indigo.opacity(0.5)))
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(note.done ? tr("Mark not done") : tr("Mark done"))
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .leading) {
            Rectangle().fill(note.priority.color).frame(width: 3).offset(x: -16)
        }
        .opacity(note.done ? 0.6 : 1)
    }
}
