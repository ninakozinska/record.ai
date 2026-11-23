import SwiftUI

/// Where are the notes? sortmemo.com, or a SortMemo server of your own.
struct ConnectView: View {
    @Environment(NoteStore.self) private var store
    @State private var address = "sortmemo.com"
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "note.text")
                            .font(.system(size: 40))
                            .foregroundStyle(.indigo)
                        Text(tr("Connect to your notes"))
                            .font(.title2.bold())
                        Text(tr("SortMemo keeps your notes at sortmemo.com. If you run your own SortMemo server, type its address instead: open SortMemo in the browser on that computer and tap your initials (top right) to see it."))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }
                Section(tr("Server address")) {
                    TextField("sortmemo.com", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(connect)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button(action: connect) {
                        HStack {
                            Text(tr("Connect"))
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                } footer: {
                    Text(tr("Your own server at home: your iPhone and that computer must be on the same network, or connected with Tailscale."))
                }
            }
            .navigationTitle("SortMemo")
        }
    }

    private func connect() {
        busy = true
        error = nil
        Task {
            do {
                try await store.connect(to: address)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
