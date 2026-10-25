// swift-tools-version:5.10
// Orbi Desktop: the macOS menu-bar helper that lets Orbi see and act on the
// whole Mac. OrbiDesktopCore is the pure, testable part (protocol, key
// combos, redaction detection, the blocklist, humanized input plans, the
// push-to-talk state machine); OrbiDesktop is the app (AppKit, AX, CGEvent,
// ScreenCaptureKit, Vision, AVAudioEngine).
import PackageDescription

let package = Package(
  name: "OrbiDesktop",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "OrbiDesktop", targets: ["OrbiDesktop"]),
  ],
  targets: [
    .target(name: "OrbiDesktopCore"),
    .executableTarget(name: "OrbiDesktop", dependencies: ["OrbiDesktopCore"]),
    .testTarget(name: "OrbiDesktopCoreTests", dependencies: ["OrbiDesktopCore"]),
  ]
)
