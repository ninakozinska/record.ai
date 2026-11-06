import AppIntents

/// "Hey Siri, hear today in SortNotes": Siri reads the day's plan without
/// opening the app. The same action is in the Shortcuts app, so it can go on
/// the Action button, the Lock Screen or the Home Screen (Shortcuts → + →
/// Add Action → SortNotes → Hear today).
struct HearTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "Hear today"
    static let description = IntentDescription("Your day's plan from SortNotes, read aloud.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = await ReadAloud.todayText()
        return .result(dialog: "\(text)")
    }
}

/// The phrases Siri knows without any set-up.
struct SortNotesShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: HearTodayIntent(),
            phrases: [
                "Hear today in \(.applicationName)",
                "Read my day in \(.applicationName)",
                "What's my day in \(.applicationName)",
            ],
            shortTitle: "Hear today",
            systemImageName: "speaker.wave.2.fill"
        )
    }
}
