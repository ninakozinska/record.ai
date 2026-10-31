import SwiftUI

/// Open a note: edit it, see what the AI found, choose a group or priority yourself.
struct NoteDetailView: View {
    @Environment(NoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let noteId: String

    @State private var text = ""
    @State private var images: [String] = []
    @State private var group = ""
    @State private var priority = ""          // "" = Auto
    @State private var loaded = false
    @State private var confirmDelete = false
    @State private var info: String?
    @State private var due: String?
    @State private var sharing = false
    @State private var remind = -1            // -1 = no reminder
    @State private var assignee = ""          // "" = anyone
    @State private var people = People(people: [], family: false)
    @State private var working = false

    private var canEdit: Bool { note?.canEdit ?? true }
    private var isShared: Bool { note?.isShared ?? false }

    private var note: Note? { store.notes[noteId] }

    var body: some View {
        NavigationStack {
            Form {
                if let note, hasAIInfo(note) {
                    Section(tr("AI")) {
                        if let s = note.summary, !s.isEmpty { Text(s) }
                        if let r = note.priorityReason, !r.isEmpty {
                            Text("Priority: \(r)").font(.subheadline).foregroundStyle(.secondary)
                        }
                        if let tags = note.tags, !tags.isEmpty {
                            Text(tags.map { "#\($0)" }.joined(separator: " ")).font(.subheadline).foregroundStyle(.indigo)
                        }
                        if note.aiStatus == "error", let e = note.aiError {
                            Text(e).font(.subheadline).foregroundStyle(.red)
                        }
                    }
                }
                if let note, note.isShared {
                    Section {
                        HStack {
                            Text("Shared by \(note.ownerName ?? "someone")" + (note.canEdit ? " · you can edit" : tr(" · view only")))
                                .font(.subheadline).foregroundStyle(.indigo)
                            Spacer()
                            Button(tr("Leave")) {
                                Task {
                                    try? await store.leave(note)
                                    dismiss()
                                }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
                Section(tr("Note")) {
                    if canEdit {
                        NoteInputs(text: $text, images: $images, minLines: 4, placeholder: tr("Note"))
                    } else {
                        Text(note?.text ?? "")
                        ForEach(note?.images ?? [], id: \.self) { name in NoteImage(name: name).frame(maxHeight: 240) }
                    }
                }
                ListItemsSection(listId: noteId, canEdit: canEdit)
                if let note { DueSection(note: note, due: $due, canEdit: canEdit && !isShared) }
                // A reminder, once the note has a date (sent as a notification by the server).
                if let note, canEdit, !isShared, (due.map { $0.isEmpty ? nil : $0 } ?? note.dueDay) != nil {
                    Section {
                        Picker(tr("Reminder"), selection: $remind) {
                            Text(tr("No reminder")).tag(-1)
                            Text(tr("At the time")).tag(0)
                            Text(tr("15 minutes before")).tag(15)
                            Text(tr("1 hour before")).tag(60)
                            Text(tr("1 day before")).tag(1440)
                        }
                    }
                }
                // Family hub: who this is for (me, or someone I share with).
                if canEdit, people.people.count > 1 {
                    Section {
                        Picker(tr("👤 For"), selection: $assignee) {
                            Text(tr("Anyone")).tag("")
                            ForEach(people.people) { p in Text(p.me == true ? tr("Me") : p.name).tag(p.id) }
                        }
                    }
                }
                if !isShared { Section {
                    TextField(groupPlaceholder, text: $group)
                    Picker(tr("Priority"), selection: $priority) {
                        Text(autoPriorityLabel).tag("")
                        ForEach(Priority.allCases) { p in Text(p.label).tag(p.rawValue) }
                    }
                } header: {
                    Text(tr("Sorting"))
                } footer: {
                    Text(tr("Leave these on Auto to let the AI decide. Your choice is kept (📌)."))
                } }
                Section {
                    if canEdit { Button(note?.done == true ? tr("Mark not done") : tr("✓ Mark done")) {
                        saveChanges()
                        store.save(id: noteId, patch: ["done": !(note?.done ?? false)])
                        dismiss()
                    } }
                    // A letter, an invitation or a photo of one: each thing to do becomes a note with its date.
                    if !isShared, let note, !note.images.isEmpty || note.text.count > 60 { Button(tr("📸 Turn into tasks")) {
                        saveChanges()
                        working = true
                        Task {
                            do {
                                let n = try await store.extractTasks(noteId)
                                working = false
                                if n == 0 { info = tr("Nothing to do in this one.") } else { dismiss() }
                            } catch {
                                working = false
                                info = error.localizedDescription
                            }
                        }
                    }.disabled(working) }
                    if !isShared { Button(tr("Re-analyze with AI")) {
                        saveChanges()
                        Task {
                            do {
                                try await store.reanalyze(noteId)
                                dismiss()
                            } catch {
                                info = error.localizedDescription
                            }
                        }
                    } }
                    if let info { Text(info).font(.footnote).foregroundStyle(.red) }
                    if !isShared { Button(tr("Delete note"), role: .destructive) { confirmDelete = true } }
                }
            }
            .navigationTitle(note?.displayTitle ?? tr("Note"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(tr("Cancel")) { dismiss() } }
                if !isShared {
                    ToolbarItem(placement: .primaryAction) {
                        Button { saveChanges(); sharing = true } label: { Image(systemName: "person.badge.plus") }
                            .accessibilityLabel(tr("Share"))
                    }
                }
                if canEdit {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(tr("Save")) {
                            saveChanges()
                            dismiss()
                        }
                        .bold()
                    }
                }
            }
            .confirmationDialog(tr("Delete this note?"), isPresented: $confirmDelete, titleVisibility: .visible) {
                Button(tr("Delete"), role: .destructive) {
                    store.save(id: noteId, patch: ["deleted": true])
                    dismiss()
                }
            }
            .sheet(isPresented: $sharing) { ShareView(kind: "note", target: noteId, label: note?.displayTitle ?? tr("Note")) }
            .onAppear(perform: load)
            .task { people = await store.people() }
        }
    }

    private var groupPlaceholder: String {
        if let g = note?.aiGroup, !g.isEmpty { return "Group: Auto (\(g))" }
        return tr("Group: Auto")
    }

    private var autoPriorityLabel: String {
        if let p = note?.aiPriority, let pr = Priority(rawValue: p) { return "Auto (\(pr.label))" }
        return tr("Auto")
    }

    private func hasAIInfo(_ n: Note) -> Bool {
        n.summary != nil || n.priorityReason != nil || !(n.tags ?? []).isEmpty || n.aiStatus == "error"
    }

    private func load() {
        guard !loaded, let note else { return }
        text = note.text
        images = note.images
        group = note.userGroup ?? ""
        priority = note.userPriority ?? ""
        due = note.userDue
        remind = note.remind ?? -1
        assignee = note.assignedTo ?? ""
        loaded = true
    }

    private func saveChanges() {
        guard let note, note.canEdit else { return }
        var patch: [String: Any] = [:]
        if text != note.text { patch["text"] = text }
        if images != note.images { patch["images"] = images }
        let g = group.trimmingCharacters(in: .whitespaces)
        if g != (note.userGroup ?? "") { patch["user_group"] = g.isEmpty ? NSNull() : g }
        if priority != (note.userPriority ?? "") { patch["user_priority"] = priority.isEmpty ? NSNull() : priority }
        if due != note.userDue { patch["user_due"] = due.map { $0 as Any } ?? NSNull() }
        if remind != (note.remind ?? -1) { patch["remind"] = remind < 0 ? NSNull() : remind }
        let who = assignee.isEmpty ? nil : assignee
        if who != note.assignedTo {
            let isMe = people.people.first { $0.id == who }?.me == true
            if who == nil || isMe || people.family == true { patch["assigned_to"] = who.map { $0 as Any } ?? NSNull() }
            else { info = tr("Giving tasks to others is part of the Family plan.") }
        }
        if note.isShared { for k in ["user_group", "user_priority", "user_due", "remind"] { patch[k] = nil } }
        if !patch.isEmpty { store.save(id: noteId, patch: patch) }
    }
}
