import SwiftUI

/// Name and email, change password, log out.
struct AccountView: View {
    @Environment(NoteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var message: String?
    @State private var messageIsError = false
    @State private var confirmLogout = false

    var body: some View {
        NavigationStack {
            Form {
                if let user = store.user {
                    Section {
                        LabeledContent("Name", value: user.name)
                        LabeledContent("Email", value: user.email)
                        if let url = store.serverURL { LabeledContent("Server", value: url.absoluteString) }
                    }
                }
                Section {
                    SecureField("Current password", text: $current)
                        .textContentType(.password)
                    SecureField("New password (at least 8 characters)", text: $new)
                        .textContentType(.newPassword)
                    Button("Change password") { changePassword() }
                        .disabled(current.isEmpty || new.isEmpty)
                    if let message {
                        Text(message).font(.footnote).foregroundStyle(messageIsError ? Color.red : Color.green)
                    }
                } header: {
                    Text("Password")
                } footer: {
                    Text("Changing your password logs out your other devices.")
                }
                Section {
                    Button("Log out other devices") {
                        Task {
                            do {
                                try await store.logoutOtherDevices()
                                show("Other devices are logged out.", error: false)
                            } catch {
                                show(error.localizedDescription, error: true)
                            }
                        }
                    }
                    Button("Log out", role: .destructive) { confirmLogout = true }
                } footer: {
                    Text("Logging out removes your notes from this iPhone. They stay safe on your server.")
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog(logoutQuestion, isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("Log out", role: .destructive) {
                    Task {
                        await store.flush()
                        await store.logout()
                        dismiss()
                    }
                }
            }
        }
    }

    private var logoutQuestion: String {
        store.unsent > 0
            ? "\(store.unsent) change(s) haven't reached the server yet and will be lost. Log out anyway?"
            : "Log out of record.ai on this iPhone?"
    }

    private func changePassword() {
        Task {
            do {
                try await store.changePassword(current: current, new: new)
                current = ""
                new = ""
                show("Password changed.", error: false)
            } catch {
                show(error.localizedDescription, error: true)
            }
        }
    }

    private func show(_ text: String, error: Bool) {
        message = text
        messageIsError = error
    }
}
