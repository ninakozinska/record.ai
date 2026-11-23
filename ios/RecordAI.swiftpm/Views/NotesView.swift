import SwiftUI

private struct EditTarget: Identifiable { let id: String }
/// What to share from the list: a whole group, or all of School.
private struct ShareTarget: Identifiable {
    let kind: String
    let target: String
    var id: String { kind + ":" + target }
}

/// The main screen: write a note at the bottom, notes sorted by priority or group above.
struct NotesView: View {
    @Environment(NoteStore.self) private var store
    @AppStorage("view") private var viewMode = "priority"
    @State private var query = ""
    @State private var group: String?
    @AppStorage("world") private var world = Worlds.all
    @State private var label: String?
    /// A name being asked for: "group", "child" or "label".
    @State private var asking: String?
    @State private var newName = ""
    @State private var sharingGroup: ShareTarget?
    @State private var showSuggested = false
    @State private var schoolShares = 0
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
                        Text(tr("🎒 School")).tag(Worlds.school)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: world) { _, _ in group = nil }
                }
                .listRowBackground(Color.clear)
                Section {
                    groupChips
                    if !store.labelsState.labels.isEmpty { labelChips }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                if !store.suggestions.isEmpty && query.isEmpty && group == nil {
                    Section {
                        Button { showSuggested = true } label: {
                            if let top = store.suggestions.first(where: { $0.top == true }) {
                                Text("⭐ " + tr("Your top to-do today:") + " " + top.title)
                            } else {
                                Text("✨ " + tr("Suggested to-dos to review: {n}").replacingOccurrences(of: "{n}", with: "\(store.suggestions.count)"))
                            }
                        }
                    }
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
                            NoteRow(note: note, showGroup: viewMode == "priority", onLabel: { label = $0 }, onDone: { markDone(note) })
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
                        HStack {
                            Text("\(section.title)  \(section.notes.count)")
                                .foregroundStyle(section.color)
                            // In Groups view: the group's world (tap to move it), and share the whole group.
                            if viewMode == "groups" && section.title != Note.sharedGroup {
                                Spacer()
                                Button(worldLabel(Worlds.of(section.title, chosen: store.chosenWorlds))) { cycleWorld(section.title) }
                                    .font(.caption)
                                    .textCase(nil)
                                Button { sharingGroup = ShareTarget(kind: "group", target: section.title) } label: {
                                    Image(systemName: "person.badge.plus")
                                }
                                .accessibilityLabel(tr("Share"))
                            }
                        }
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
                                NoteRow(note: note, showGroup: true, onDone: { markDone(note) })
                                    .contentShape(Rectangle())
                                    .onTapGesture { editing = EditTarget(id: note.id) }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: tr("Search notes"))
            .task(id: store.user?.id) {
                await store.refreshAccount()
                await loadSchoolShares()
            }
            .refreshable {
                await store.pull()
                await store.flush()
                await store.refreshAccount()
            }
            .navigationTitle("SortMemo")
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
                    Button { Task { await ReadAloud.hearToday() } } label: {
                        Image(systemName: "speaker.wave.2.fill")
                    }
                    .accessibilityLabel(tr("Hear today"))
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
            .sheet(isPresented: $showSuggested) { SuggestionsView() }
            .sheet(item: $sharingGroup, onDismiss: { Task { await loadSchoolShares() } }) { t in
                ShareView(kind: t.kind, target: t.target, label: t.kind == "school" ? tr("🎒 School") : t.target)
            }
            .alert(askTitle, isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })) {
                TextField(askPrompt, text: $newName)
                Button(tr("Add")) { addName() }
                Button(tr("Cancel"), role: .cancel) { newName = "" }
            } message: {
                Text(askPrompt)
            }
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
                    chip(world == Worlds.school ? Worlds.childName(name) : name, selected: group == name) { group = name }
                }
                if world == Worlds.school {
                    // One school group per child; and all of School shared at once.
                    chip(tr("＋ Child"), selected: false) { ask("child") }
                    chip("👥 " + (schoolShares > 0 ? tr("School shared · {n}").replacingOccurrences(of: "{n}", with: "\(schoolShares)") : tr("Share School")),
                         selected: false) { sharingGroup = ShareTarget(kind: "school", target: "School") }
                } else {
                    chip(tr("＋ Group"), selected: false) { ask("group") }
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
        }
    }

    /// Labels, like Gmail's (Premium): tap one to see only its notes.
    private var labelChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.labelsState.labels, id: \.name) { l in
                    LabelChip(name: l.name, color: l.color, on: activeLabel == nil || activeLabel == l.name) {
                        label = activeLabel == l.name ? nil : l.name
                    }
                }
                if store.labelsState.allowed { chip(tr("＋ Label"), selected: false) { ask("label") } }
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 6)
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

    // MARK: Groups, children, labels

    private func ask(_ what: String) {
        newName = ""
        asking = what
    }

    private var askTitle: String {
        switch asking {
        case "child": return tr("＋ Child")
        case "label": return tr("＋ Label")
        default: return tr("＋ Group")
        }
    }

    private var askPrompt: String {
        switch asking {
        case "child": return tr("Your child's first name.\nSchool notes about them go in their own group:")
        case "label": return tr("New label (for example Leo, Bills or Doctor):")
        default: return tr("New group (for example Baby or Work).\nThe AI will put matching notes in it:")
        }
    }

    private func addName() {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        let what = asking
        newName = ""
        guard !name.isEmpty else { return }
        Task {
            do {
                switch what {
                case "child":
                    group = try await store.addMyGroup(Worlds.childGroup(name))
                    show(tr("Added"))
                case "label":
                    _ = try await store.addLabel(name)
                default:
                    try await store.addMyGroup(name)
                    show(tr("Added"))
                }
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    /// Work → Family → School → all worlds → Work, for one group, on every device.
    private func cycleWorld(_ group: String) {
        let next: String
        switch Worlds.of(group, chosen: store.chosenWorlds) {
        case Worlds.work: next = Worlds.family
        case Worlds.family: next = Worlds.school
        case Worlds.school: next = ""
        default: next = Worlds.work
        }
        Task {
            do {
                try await store.setWorld(group, next)
                show(worldMoved(group, next))
            } catch {
                show(error.localizedDescription)
            }
        }
    }

    private func loadSchoolShares() async {
        let mine = try? await store.shares().mine
        if let mine { schoolShares = mine.filter { $0.kind == "school" }.count }
    }

    // MARK: Data

    private struct NoteSection {
        var title: String
        var color: Color
        var notes: [Note]
    }

    private var groupNames: [String] {
        Worlds.withMyGroups(store.groupNames, store.myGroups).filter { Worlds.shows($0, in: world, chosen: store.chosenWorlds) }
    }

    /// A label that was removed (on another device, say) no longer filters.
    private var activeLabel: String? {
        guard let label, store.labelsState.labels.contains(where: { $0.name == label }) else { return nil }
        return label
    }

    private var filtered: [Note] {
        store.visibleNotes.filter { n in
            if !Worlds.shows(n.group, in: world, chosen: store.chosenWorlds) { return false }
            if let group, n.group != group { return false }
            if let activeLabel, !n.shownLabels.contains(activeLabel) { return false }
            let fields = [n.text, n.title ?? "", n.summary ?? "", n.group] + (n.tags ?? []) + store.items(of: n.id).map(\.text)
            return NoteSearch.matches(fields: fields, labels: n.shownLabels, query: query)
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
    var onLabel: (String) -> Void = { _ in }
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
                WhichChildRow(note: note)
                // Its labels; tap one to see only the notes with it.
                if !note.shownLabels.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(note.shownLabels, id: \.self) { l in
                                LabelChip(name: l, color: store.labelsState.color(of: l), on: true) { onLabel(l) }
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
