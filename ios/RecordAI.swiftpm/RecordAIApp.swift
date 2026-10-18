import SwiftUI
import UIKit

@main
struct RecordAIApp: App {
    @State private var store = NoteStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .tint(.indigo)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: store.start()
            case .background:
                store.stopLive()
                // Ask iOS for a few seconds to send unsent changes.
                let task = UIApplication.shared.beginBackgroundTask(withName: "sync")
                Task {
                    await store.flush()
                    UIApplication.shared.endBackgroundTask(task)
                }
            default: break
            }
        }
    }
}

/// Chooses the screen: connect to a server, log in, or the notes.
struct RootView: View {
    @Environment(NoteStore.self) private var store

    var body: some View {
        Group {
            if store.serverURL == nil {
                ConnectView()
            } else if !store.isLoggedIn {
                LoginView()
            } else {
                NotesView()
            }
        }
        .animation(.default, value: store.isLoggedIn)
    }
}
