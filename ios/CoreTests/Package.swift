// swift-tools-version: 5.9
// Tests for the iPhone app's rules that don't need the screen: the Work and
// Family worlds and the translations. The sources are links to the app's own
// files. Run on a Mac: swift test --package-path ios/CoreTests
import PackageDescription

let package = Package(
    name: "RecordAICore",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "RecordAICore", path: "Sources/RecordAICore"),
        .testTarget(name: "RecordAICoreTests", dependencies: ["RecordAICore"], path: "Tests/RecordAICoreTests"),
    ]
)
