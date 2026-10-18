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
    @State private var info: AccountInfo?

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
                if let info, !info.identities.isEmpty {
                    Section {
                        ForEach(info.identities) { identity in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(identity.name)
                                    if let email = identity.email, !email.isEmpty {
                                        Text(email).font(.footnote).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Button("Disconnect", role: .destructive) { disconnect(identity.provider) }
                                    .buttonStyle(.borderless)
                            }
                        }
                    } header: {
                        Text("Sign-in options")
                    } footer: {
                        Text("To connect more, open record.ai in a browser and tap your initials.")
                    }
                }
                Section {
                    if hasPassword {
                        SecureField("Current password", text: $current)
                            .textContentType(.password)
                    }
                    SecureField("New password (at least 8 characters)", text: $new)
                        .textContentType(.newPassword)
                    Button(hasPassword ? "Change password" : "Set password") { changePassword() }
                        .disabled((hasPassword && current.isEmpty) || new.isEmpty)
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
            .task { await loadInfo() }
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
                show("Password saved.", error: false)
                await loadInfo()
            } catch {
                show(error.localizedDescription, error: true)
            }
        }
    }

    /// Accounts made with Google etc. have no password until they set one.
    private var hasPassword: Bool { info?.hasPassword ?? true }

    private func loadInfo() async {
        do {
            info = try await store.accountInfo()
        } catch {
            info = nil
        }
    }

    private func disconnect(_ provider: String) {
        Task {
            do {
                try await store.disconnect(provider: provider)
                await loadInfo()
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
