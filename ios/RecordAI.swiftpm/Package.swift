// swift-tools-version: 5.9

// SortMemo for iPhone.
// To run it: double-click this folder in Finder (it opens in Xcode),
// pick your iPhone at the top of the window, then press Run (▶).
// To put it on the App Store: docs/ReleaseAppStore.md.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "SortMemo",
    // iOS 26 or newer. Apple only accepts uploads whose program file says it was
    // built for iOS 26 or later, and for a Swift package like this one Xcode
    // writes this minimum version there. With 17.0 the upload was refused.
    platforms: [
        .iOS("26.0")
    ],
    products: [
        .iOSApplication(
            name: "SortMemo",
            targets: ["AppModule"],
            // The app's permanent name in the App Store: it must match the app made
            // in App Store Connect, and can never change once the app is published.
            bundleIdentifier: "com.sortmemo.app",
            teamIdentifier: "",
            // What people see (1.0.0), and the build number: raise the build number
            // by 1 for every upload to App Store Connect.
            displayVersion: "1.0.0",
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
                .camera(purposeString: "SortMemo uses the camera only when you tap it, to add a photo to a note."),
                .microphone(purposeString: "SortMemo uses the microphone only while you dictate a note."),
                .speechRecognition(purposeString: "SortMemo turns what you say into note text. Only the text is kept."),
                .localNetwork(purposeString: "SortMemo can connect to a SortMemo server of your own on your home network.")
            ],
            appCategory: .productivity,
            // More Info.plist settings: the photo library text and "no special encryption".
            additionalInfoPlistContentFilePath: "Info.plist"
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: ".",
            exclude: ["Info.plist"],
            resources: [
                // Apple's privacy manifest: what the app collects, and why it uses UserDefaults.
                .copy("PrivacyInfo.xcprivacy")
            ]
        )
    ]
)
