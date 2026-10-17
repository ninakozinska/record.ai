import PhotosUI
import SwiftUI

/// Text field, dictation, camera and photo buttons. Used for new notes and when editing.
struct NoteInputs: View {
    @Environment(NoteStore.self) private var store
    @Binding var text: String
    @Binding var images: [String]
    var minLines = 1
    var placeholder = "Write a note, or tap 🎤 to dictate…"

    @State private var dictation = Dictation()
    @State private var baseText = ""
    @State private var showCamera = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(minLines...10)
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(images, id: \.self) { name in
                            NoteImage(name: name)
                                .frame(width: 64, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(alignment: .topTrailing) {
                                    Button { images.removeAll { $0 == name } } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .symbolRenderingMode(.palette)
                                            .foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 6, y: -6)
                                }
                        }
                    }
                    .padding(.top, 6)
                }
            }
            if let err = dictation.errorMessage {
                Text(err).font(.footnote).foregroundStyle(.red)
            }
            HStack(spacing: 18) {
                Button {
                    if !dictation.isRecording { baseText = text }
                    Task { await dictation.toggle() }
                } label: {
                    Image(systemName: dictation.isRecording ? "stop.circle.fill" : "mic")
                        .foregroundStyle(dictation.isRecording ? Color.red : Color.indigo)
                        .symbolEffect(.pulse, isActive: dictation.isRecording)
                }
                .accessibilityLabel(dictation.isRecording ? "Stop dictation" : "Dictate")

                if CameraPicker.isAvailable {
                    Button { showCamera = true } label: { Image(systemName: "camera") }
                        .accessibilityLabel("Take a photo")
                }
                PhotosPicker(selection: $photoItems, maxSelectionCount: 10, matching: .images) {
                    Image(systemName: "photo.on.rectangle")
                }
                .accessibilityLabel("Add photos")
            }
            .font(.title3)
        }
        .onChange(of: dictation.transcript) { _, spoken in
            guard !spoken.isEmpty else { return }
            let sep = baseText.isEmpty || baseText.hasSuffix(" ") || baseText.hasSuffix("\n") ? "" : " "
            text = baseText + sep + spoken
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let image = UIImage(data: data),
                       let name = store.addImage(image) {
                        images.append(name)
                    }
                }
                photoItems = []
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                if let name = store.addImage(image) { images.append(name) }
            }
            .ignoresSafeArea()
        }
        .onDisappear { dictation.stop() }
    }
}

/// The bar at the bottom of the notes list for writing a new note.
struct ComposerView: View {
    @Environment(NoteStore.self) private var store
    @State private var text = ""
    @State private var images: [String] = []

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            NoteInputs(text: $text, images: $images)
            Button(action: save) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
            }
            .disabled(isEmpty)
            .accessibilityLabel("Save note")
        }
        .padding(12)
        .background(.bar)
    }

    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
    }

    private func save() {
        guard !isEmpty else { return }
        store.create(text: text.trimmingCharacters(in: .whitespacesAndNewlines), images: images)
        text = ""
        images = []
    }
}
