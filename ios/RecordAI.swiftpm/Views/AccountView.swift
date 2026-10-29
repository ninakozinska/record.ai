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
    @State private var plan: Plan?
    @State private var backups: [Backup] = []
    @State private var restoring: Backup?
    @State private var deleting = false
    @State private var deleteEmail = ""

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
                if let plan {
                    Section {
                        if plan.premium {
                            Button("Back up now") {
                                Task {
                                    do {
                                        try await store.backupNow()
                                        show("Backup made.", error: false)
                                        await loadInfo()
                                    } catch {
                                        show(error.localizedDescription, error: true)
                                    }
                                }
                            }
                            ForEach(backups.prefix(10)) { b in
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(Date(timeIntervalSince1970: b.createdAt / 1000), format: .dateTime.day().month().year().hour().minute())
                                        Text("\(b.notes) notes" + (b.kind == "manual" ? " · by hand" : b.kind == "before-restore" ? " · before a restore" : ""))
                                            .font(.footnote).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button("Restore") { restoring = b }.buttonStyle(.borderless)
                                }
                            }
                        } else {
                            Text("Daily backups kept 30 days, and restoring them, are part of Premium.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("Premium")
                    } footer: {
                        if plan.premium { Text("A backup of your notes is made every day and kept 30 days.") }
                    }
                }
                Section {
                    Button("Delete my account", role: .destructive) { deleting = true }
                } footer: {
                    Text("Deletes your account, all your notes and photos, and your backups, for good.")
                }
            }
            .task { await loadInfo() }
            .alert("Restore this backup?", isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } })) {
                Button("Restore") {
                    guard let b = restoring else { return }
                    Task {
                        do {
                            try await store.restore(b.id)
                            show("Restored.", error: false)
                            await loadInfo()
                        } catch {
                            show(error.localizedDescription, error: true)
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your notes go back to how they were then. Notes written since are deleted. A backup of how they are now is made first, so you can undo this.")
            }
            .alert("Delete your account?", isPresented: $deleting) {
                TextField("Type your email to confirm", text: $deleteEmail)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                Button("Delete for good", role: .destructive) {
                    Task {
                        do {
                            try await store.deleteAccount(email: deleteEmail)
                            dismiss()
                        } catch {
                            deleteEmail = ""
                            show(error.localizedDescription, error: true)
                        }
                    }
                }
                Button("Cancel", role: .cancel) { deleteEmail = "" }
            } message: {
                Text("This deletes your account, all your notes and photos, and your backups. People you shared with lose access to them.")
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
        plan = try? await store.plan()
        if plan?.premium == true { backups = (try? await store.backups()) ?? [] }
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
