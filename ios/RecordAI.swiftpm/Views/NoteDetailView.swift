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
                        if let d = note.dueDate { Text("Due \(d)").font(.subheadline).foregroundStyle(.secondary) }
                        if let tags = note.tags, !tags.isEmpty {
                            Text(tags.map { "#\($0)" }.joined(separator: " ")).font(.subheadline).foregroundStyle(.indigo)
                        }
                        if note.aiStatus == "error", let e = note.aiError {
                            Text(e).font(.subheadline).foregroundStyle(.red)
                        }
                    }
                }
                Section("Note") {
                    NoteInputs(text: $text, images: $images, minLines: 4, placeholder: "Note")
                }
                Section {
                    TextField(groupPlaceholder, text: $group)
                    Picker("Priority", selection: $priority) {
                        Text(autoPriorityLabel).tag("")
                        ForEach(Priority.allCases) { p in Text(p.label).tag(p.rawValue) }
                    }
                } header: {
                    Text("Sorting")
                } footer: {
                    Text("Leave these on Auto to let the AI decide. Your choice is kept (📌).")
                }
                Section {
                    Button(note?.done == true ? "Mark not done" : "Mark done") {
                        saveChanges()
                        store.save(id: noteId, patch: ["done": !(note?.done ?? false)])
                        dismiss()
                    }
                    Button("Re-analyze with AI") {
                        saveChanges()
                        Task {
                            do {
                                try await store.reanalyze(noteId)
                                dismiss()
                            } catch {
                                info = error.localizedDescription
                            }
                        }
                    }
                    if let info { Text(info).font(.footnote).foregroundStyle(.red) }
                    Button("Delete note", role: .destructive) { confirmDelete = true }
                }
            }
            .navigationTitle(note?.displayTitle ?? "Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveChanges()
                        dismiss()
                    }
                    .bold()
                }
            }
            .confirmationDialog("Delete this note?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    store.save(id: noteId, patch: ["deleted": true])
                    dismiss()
                }
            }
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
        n.summary != nil || n.priorityReason != nil || n.dueDate != nil || !(n.tags ?? []).isEmpty || n.aiStatus == "error"
    }

    private func load() {
        guard !loaded, let note else { return }
        text = note.text
        images = note.images
        group = note.userGroup ?? ""
        priority = note.userPriority ?? ""
        loaded = true
    }

    private func saveChanges() {
        guard let note else { return }
        var patch: [String: Any] = [:]
        if text != note.text { patch["text"] = text }
        if images != note.images { patch["images"] = images }
        let g = group.trimmingCharacters(in: .whitespaces)
        if g != (note.userGroup ?? "") { patch["user_group"] = g.isEmpty ? NSNull() : g }
        if priority != (note.userPriority ?? "") { patch["user_priority"] = priority.isEmpty ? NSNull() : priority }
        if !patch.isEmpty { store.save(id: noteId, patch: patch) }
    }
}
