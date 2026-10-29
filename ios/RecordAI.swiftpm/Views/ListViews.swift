import EventKit
import EventKitUI
import SwiftUI

/// "📅 Today 09:30", "📅 Tue, 3 Nov", "overdue 2d"; and whether it is soon.
func dueText(_ note: Note) -> (String, Bool)? {
    guard let day = note.dueDay else { return nil }
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    guard let date = f.date(from: day) else { return nil }
    let cal = Calendar.current
    let days = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: date).day ?? 0
    let time = note.dueHour.map { " \($0)" } ?? ""
    if days < 0 { return ("overdue \(-days)d", true) }
    if days == 0 { return ("📅 Today\(time)", true) }
    if days == 1 { return ("📅 Tomorrow\(time)", true) }
    let sameYear = cal.component(.year, from: date) == cal.component(.year, from: Date())
    let label = date.formatted(sameYear ? .dateTime.weekday(.abbreviated).day().month(.abbreviated)
                                        : .dateTime.weekday(.abbreviated).day().month(.abbreviated).year())
    return ("📅 \(label)\(time)", days < 7)
}

/// A list's items in the note screen: tick them, add more, remove them.
struct ListItemsSection: View {
    @Environment(NoteStore.self) private var store
    let listId: String
    let canEdit: Bool
    @State private var newItem = ""
    @State private var pasted: [String]?

    var body: some View {
        let items = store.items(of: listId)
        Section {
            ForEach(items) { item in
                HStack {
                    Button { store.setDone(item.id, !item.done) } label: {
                        Image(systemName: item.done ? "checkmark.square.fill" : "square")
                            .foregroundStyle(item.done ? Color.indigo : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canEdit)
                    Text(item.text)
                        .strikethrough(item.done)
                        .foregroundStyle(item.done ? .secondary : .primary)
                }
                .swipeActions {
                    if canEdit {
                        Button(role: .destructive) { store.save(id: item.id, patch: ["deleted": true]) } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }
            if canEdit {
                TextField("+ Add an item", text: $newItem)
                    .onSubmit(add)
                    .submitLabel(.done)
                    .onChange(of: newItem) { old, new in
                        if new.count - old.count > 1, let lines = NoteStore.pastedLines(new) { pasted = lines }
                    }
            }
        } header: {
            if !items.isEmpty { Text("☑ \(items.filter(\.done).count)/\(items.count)") }
        }
        .confirmationDialog("Paste \(pasted?.count ?? 0) lines", isPresented: Binding(get: { pasted != nil }, set: { if !$0 { pasted = nil } }),
                            titleVisibility: .visible) {
            if let lines = pasted {
                Button("Add \(lines.count) items") {
                    for line in lines { store.addItem(to: listId, text: line, send: false) }
                    store.sendNow()
                    newItem = ""
                }
                Button("Add as one item") {
                    store.addItem(to: listId, text: lines.joined(separator: ", "))
                    newItem = ""
                }
                Button("Cancel", role: .cancel) { newItem = "" }
            }
        }
    }

    private func add() {
        let t = newItem.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { store.addItem(to: listId, text: t) }
        newItem = ""
    }
}

/// The note's date and time: pick them, remove them, or let the AI decide.
/// `due` follows user_due: nil = the AI decides, "" = no date.
struct DueSection: View {
    let note: Note
    @Binding var due: String?
    let canEdit: Bool
    @State private var showCalendar = false

    private var shownDay: String? { due.map { $0.isEmpty ? nil : String($0.prefix(10)) } ?? (note.aiDueDate ?? note.dueDate) }
    private var shownHour: String? { due.map { $0.count >= 16 ? String($0.dropFirst(11).prefix(5)) : nil } ?? (note.aiDueTime ?? note.dueTime) }

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let hourFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private var date: Date? {
        guard let shownDay, let day = Self.dayFormat.date(from: shownDay) else { return nil }
        guard let shownHour, let t = Self.hourFormat.date(from: shownHour) else { return day }
        let c = Calendar.current.dateComponents([.hour, .minute], from: t)
        return Calendar.current.date(bySettingHour: c.hour ?? 0, minute: c.minute ?? 0, second: 0, of: day)
    }

    var body: some View {
        Section {
            if canEdit {
                DatePicker("Date", selection: Binding(
                    get: { date ?? Date() },
                    set: { d in due = Self.dayFormat.string(from: d) + (shownHour.map { "T\($0)" } ?? "") }
                ), displayedComponents: .date)
                Toggle("Time", isOn: Binding(
                    get: { shownHour != nil },
                    set: { on in
                        let day = shownDay ?? Self.dayFormat.string(from: Date())
                        due = on ? "\(day)T09:00" : day
                    }
                ))
                if shownHour != nil {
                    DatePicker("At", selection: Binding(
                        get: { date ?? Date() },
                        set: { d in due = (shownDay ?? Self.dayFormat.string(from: d)) + "T" + Self.hourFormat.string(from: d) }
                    ), displayedComponents: .hourAndMinute)
                }
                HStack {
                    Button("No date") { due = "" }.buttonStyle(.bordered).tint(due == "" ? .indigo : .secondary)
                    Button("Let AI decide") { due = nil }.buttonStyle(.bordered).tint(due == nil ? .indigo : .secondary)
                }
            } else if let shown = dueText(note) {
                Text(shown.0)
            }
            if date != nil {
                Button("Add to my calendar") { showCalendar = true }
            }
        } header: {
            Text("Date" + (due == nil && shownDay != nil ? " (chosen by AI)" : ""))
        }
        .sheet(isPresented: $showCalendar) {
            if let date { CalendarEventView(title: note.displayTitle, notes: note.text, start: date, allDay: shownHour == nil) }
        }
    }
}

/// The iPhone's own "New Event" screen, filled in; the person checks it and taps Add.
struct CalendarEventView: UIViewControllerRepresentable {
    let title: String
    let notes: String
    let start: Date
    let allDay: Bool
    private let eventStore = EKEventStore()

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.notes = notes
        event.startDate = start
        event.endDate = start.addingTimeInterval(allDay ? 86400 : 3600)
        event.isAllDay = allDay
        let vc = EKEventEditViewController()
        vc.eventStore = eventStore
        vc.event = event
        vc.editViewDelegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: EKEventEditViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            controller.dismiss(animated: true)
        }
    }
}

/// Share a note (with its items) or a whole group by email; see who it is shared with.
struct ShareView: View {
    @Environment(NoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let kind: String
    let target: String
    let label: String
    @State private var shares: [Share] = []
    @State private var email = ""
    @State private var role = "edit"
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Their email", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("They", selection: $role) {
                        Text("Can edit").tag("edit")
                        Text("View only").tag("view")
                    }
                    .pickerStyle(.segmented)
                    Button("Share") { share() }.disabled(!email.contains("@"))
                    if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                } footer: {
                    Text(kind == "group" ? "Everyone you add sees every note in this group, also ones added later."
                                         : "They see this note and its items on their phone or computer.")
                }
                if !shares.isEmpty {
                    Section("Shared with") {
                        ForEach(shares) { s in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(s.name ?? s.email ?? "")
                                    Text((s.role == "view" ? "View only" : "Can edit") + (s.name == nil ? " · invited" : ""))
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(s.role == "view" ? "Allow edits" : "View only") {
                                    Task { try? await store.setShareRole(s.id, role: s.role == "view" ? "edit" : "view"); await reload() }
                                }
                                .buttonStyle(.borderless)
                            }
                            .swipeActions {
                                Button("Stop", role: .destructive) { Task { try? await store.unshare(s.id); await reload() } }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Share \"\(label)\"")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await reload() }
        }
    }

    private func reload() async {
        do {
            shares = try await store.shares().mine.filter {
                $0.kind == kind && (kind == "group" ? $0.target.lowercased() == target.lowercased() : $0.target == target)
            }
        } catch {
            message = error.localizedDescription
        }
    }

    private func share() {
        let to = email.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                try await store.share(kind: kind, target: target, email: to, role: role)
                message = "Shared with \(to)"
                email = ""
                await reload()
            } catch {
                message = error.localizedDescription
            }
        }
    }
}
