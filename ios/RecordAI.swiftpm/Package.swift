// swift-tools-version: 5.9

// record.ai for iPhone.
// To run it: double-click this folder in Finder (it opens in Xcode),
// pick your iPhone at the top of the window, then press Run (▶).

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "record.ai",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "record.ai",
            targets: ["AppModule"],
            bundleIdentifier: "com.ninakozinska.recordai",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .asset("AppIcon"),
            accentColor: .presetColor(.indigo),
            supportedDeviceFamilies: [
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait
            ],
            capabilities: [
                .camera(purposeString: "Take photos to add to your notes."),
                .microphone(purposeString: "Dictate notes with your voice."),
                .speechRecognition(purposeString: "Turn what you say into note text."),
                .localNetwork(purposeString: "Connect to your record.ai server on your Mac.")
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
