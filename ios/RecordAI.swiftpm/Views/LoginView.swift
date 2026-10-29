import AuthenticationServices
import SwiftUI

/// Log in, or create an account.
struct LoginView: View {
    @Environment(NoteStore.self) private var store
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var signingUp = false
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var error: String?
    @State private var info: String?
    @State private var busy = false

    private var policy: SignupPolicy? { store.signupPolicy }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(intro).foregroundStyle(.secondary)
                }
                if !store.providers.isEmpty {
                    Section {
                        ForEach(store.providers) { provider in
                            Button {
                                continueWith(provider)
                            } label: {
                                Label("Continue with \(provider.name)", systemImage: "person.crop.circle.badge.checkmark")
                            }
                            .disabled(busy)
                        }
                    } footer: {
                        Text("Or use your email and password:")
                    }
                }
                Section {
                    if signingUp {
                        TextField("Your name", text: $name)
                            .textContentType(.name)
                    }
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(signingUp ? .newPassword : .password)
                    if signingUp && policy?.needsCode == true {
                        TextField("Invite code", text: $code)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button(action: submit) {
                        HStack {
                            Text(signingUp ? "Create account" : "Log in").bold()
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty)
                    if !signingUp {
                        Button("Forgot your password?") { forgot() }
                    }
                    if let info { Text(info).font(.footnote).foregroundStyle(.secondary) }
                    if canSwitch {
                        Button(signingUp ? "I already have an account" : "Create an account") {
                            signingUp.toggle()
                            error = nil
                        }
                    }
                }
                Section {
                    Button("Use a different server", role: .destructive) { store.forgetServer() }
                } footer: {
                    if let url = store.serverURL { Text("Connected to \(url.absoluteString)") }
                }
            }
            .navigationTitle(signingUp ? (policy?.firstAccount == true ? "Create your account" : "Create an account") : "Log in")
            .task {
                try? await store.refreshAuthState()
                if store.signupPolicy?.firstAccount == true { signingUp = true }
            }
        }
    }

    private var canSwitch: Bool {
        guard let policy else { return true }
        return policy.open && !policy.firstAccount
    }

    private var intro: String {
        if signingUp && policy?.firstAccount == true {
            return "This is the first account on your server. It will own all notes already saved there."
        }
        return signingUp ? "Your notes are private to your account." : "Log in with the same email and password as on your Mac."
    }

    /// Opens the provider's sign-in page in Apple's secure sheet; it comes back
    /// to recordai://auth with a one-time code.
    private func continueWith(_ provider: AuthProvider) {
        let invite = signingUp ? code.trimmingCharacters(in: .whitespaces) : ""
        guard let start = store.socialLoginStart(provider: provider.id, invite: invite) else { return }
        busy = true
        error = nil
        Task {
            do {
                let callback = try await webAuthenticationSession.authenticate(
                    using: start.url, callbackURLScheme: "recordai", preferredBrowserSession: .shared)
                try await store.socialLoginFinish(callback: callback, verifier: start.verifier)
            } catch let cancel as ASWebAuthenticationSessionError where cancel.code == .canceledLogin {
                // The person closed the sheet: nothing to say.
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func submit() {
        busy = true
        error = nil
        Task {
            do {
                if signingUp {
                    try await store.signup(name: name.trimmingCharacters(in: .whitespaces),
                                           email: email.trimmingCharacters(in: .whitespaces),
                                           password: password, code: code)
                } else {
                    try await store.login(email: email.trimmingCharacters(in: .whitespaces), password: password)
                }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func forgot() {
        error = nil
        guard !email.trimmingCharacters(in: .whitespaces).isEmpty else {
            error = "Type your email above, then tap this again."
            return
        }
        Task {
            do {
                try await store.forgotPassword(email: email)
                info = "If an account uses this email, a link to choose a new password is on its way. Then log in here with it."
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
