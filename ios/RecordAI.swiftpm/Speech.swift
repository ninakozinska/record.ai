import AVFoundation
import SwiftUI

/// Reading notes aloud (Premium), with a voice of this iPhone chosen in the account screen.
@MainActor
enum ReadAloud {
    static let synthesizer = AVSpeechSynthesizer()

    /// The iPhone's voices, the app's language first.
    static var voices: [AVSpeechSynthesisVoice] {
        let all = AVSpeechSynthesisVoice.speechVoices()
        let mine = all.filter { $0.language.hasPrefix(appLanguage) }
        return mine + all.filter { !$0.language.hasPrefix(appLanguage) }
    }

    /// Reads the text, or stops if something is being read.
    static func speak(_ text: String) {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        let chosen = UserDefaults.standard.string(forKey: "voice") ?? ""
        utterance.voice = AVSpeechSynthesisVoice(identifier: chosen) ?? voices.first
        let speed = UserDefaults.standard.double(forKey: "voiceRate")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * Float(speed > 0 ? speed : 1)
        synthesizer.speak(utterance)
    }

    /// "Hear today": what to say, from the server; for Siri too, which runs without the app's screen.
    static func todayText() async -> String {
        let server = UserDefaults.standard.string(forKey: "serverURL").flatMap { URL(string: $0) }
        guard let server, let token = Keychain.load("token") else { return tr("Log in to SortNotes first.") }
        do {
            let day = try await API(baseURL: server, token: token).get("today/spoken", as: SpokenDay.self)
            return day.canRead ? day.text : tr("Reading aloud is part of Premium.")
        } catch {
            return error.localizedDescription
        }
    }

    /// Reads today's plan in the app (or stops reading).
    static func hearToday() async {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
            return
        }
        speak(await todayText())
    }

    /// A note as it is read: the title, the text, the open items.
    static func text(of note: Note, items: [Note]) -> String {
        let title = note.displayTitle
        let body = note.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let open = items.filter { !$0.done }.map(\.text).joined(separator: ", ")
        return [title, body == title ? "" : body, open].filter { !$0.isEmpty }.joined(separator: ". ")
    }
}

/// The account screen's voice choice.
struct VoiceSection: View {
    let premium: Bool
    @AppStorage("voice") private var voice = ""
    @AppStorage("voiceRate") private var rate = 1.0

    var body: some View {
        Section {
            if premium {
                Picker(tr("Voice"), selection: $voice) {
                    ForEach(ReadAloud.voices, id: \.identifier) { v in
                        Text("\(v.name) · \(v.language)").tag(v.identifier)
                    }
                }
                Picker(tr("Speed"), selection: $rate) {
                    Text(tr("Slow")).tag(0.8)
                    Text(tr("Normal")).tag(1.0)
                    Text(tr("Fast")).tag(1.2)
                }
                Button(tr("▶ Try it")) { ReadAloud.speak(tr("Hello! This is how your notes will sound.")) }
            } else {
                Text(tr("Reading aloud is part of Premium.")).foregroundStyle(.secondary)
            }
        } header: {
            Text(tr("🔊 Read aloud"))
        } footer: {
            Text(tr("Notes and your day read aloud, with the voice you like. The voices come from this device."))
        }
    }
}
