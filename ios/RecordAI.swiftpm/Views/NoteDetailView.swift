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

    private var canEdit: Bool { note?.canEdit ?? true }
    private var isShared: Bool { note?.isShared ?? false }

    private var note: Note? { store.notes[noteId] }

    var body: some View {
        NavigationStack {
            Form {
                if let note, hasAIInfo(note) {
                    Section("AI") {
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
                            Text("Shared by \(note.ownerName ?? "someone")" + (note.canEdit ? " · you can edit" : " · view only"))
                                .font(.subheadline).foregroundStyle(.indigo)
                            Spacer()
                            Button("Leave") {
                                Task {
                                    try? await store.leave(note)
                                    dismiss()
                                }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
                Section("Note") {
                    if canEdit {
                        NoteInputs(text: $text, images: $images, minLines: 4, placeholder: "Note")
                    } else {
                        Text(note?.text ?? "")
                        ForEach(note?.images ?? [], id: \.self) { name in NoteImage(name: name).frame(maxHeight: 240) }
                    }
                }
                ListItemsSection(listId: noteId, canEdit: canEdit)
                if let note { DueSection(note: note, due: $due, canEdit: canEdit && !isShared) }
                if !isShared { Section {
                    TextField(groupPlaceholder, text: $group)
                    Picker("Priority", selection: $priority) {
                        Text(autoPriorityLabel).tag("")
                        ForEach(Priority.allCases) { p in Text(p.label).tag(p.rawValue) }
                    }
                } header: {
                    Text("Sorting")
                } footer: {
                    Text("Leave these on Auto to let the AI decide. Your choice is kept (📌).")
                } }
                Section {
                    if canEdit { Button(note?.done == true ? "Mark not done" : "✓ Mark done") {
                        saveChanges()
                        store.save(id: noteId, patch: ["done": !(note?.done ?? false)])
                        dismiss()
                    } }
                    if !isShared { Button("Re-analyze with AI") {
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
                    if !isShared { Button("Delete note", role: .destructive) { confirmDelete = true } }
                }
            }
            .navigationTitle(note?.displayTitle ?? "Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                if !isShared {
                    ToolbarItem(placement: .primaryAction) {
                        Button { saveChanges(); sharing = true } label: { Image(systemName: "person.badge.plus") }
                            .accessibilityLabel("Share")
                    }
                }
                if canEdit {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            saveChanges()
                            dismiss()
                        }
                        .bold()
                    }
                }
            }
            .confirmationDialog("Delete this note?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    store.save(id: noteId, patch: ["deleted": true])
                    dismiss()
                }
            }
            .sheet(isPresented: $sharing) { ShareView(kind: "note", target: noteId, label: note?.displayTitle ?? "Note") }
            .onAppear(perform: load)
        }
    }

    private var groupPlaceholder: String {
        if let g = note?.aiGroup, !g.isEmpty { return "Group: Auto (\(g))" }
        return "Group: Auto"
    }

    private var autoPriorityLabel: String {
        if let p = note?.aiPriority, let pr = Priority(rawValue: p) { return "Auto (\(pr.label))" }
        return "Auto"
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
        if note.isShared { for k in ["user_group", "user_priority", "user_due"] { patch[k] = nil } }
        if !patch.isEmpty { store.save(id: noteId, patch: patch) }
    }
}
