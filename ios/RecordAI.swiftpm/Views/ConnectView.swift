import SwiftUI

/// First screen: where is the record.ai server (the Mac)?
struct ConnectView: View {
    @Environment(NoteStore.self) private var store
    @State private var address = ""
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
                        Text(tr("Enter the address of your record.ai server. On your Mac, open record.ai in the browser and tap your initials (top right): the address is shown there."))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }
                Section(tr("Server address")) {
                    TextField("http://172.20.10.2:3000", text: $address)
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
                    Text(tr("Your iPhone and your Mac must be on the same network (for example your iPhone's hotspot), or connected with Tailscale."))
                }
            }
            .navigationTitle("record.ai")
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
