import AVFoundation
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import OrbiDesktopCore

// Launch-time switches, from the environment (handy for development and the
// smoke test):
//   ORBI_DESKTOP_SOCKET    the server's Unix socket, default
//                          ~/Library/Application Support/Orbi/desktop.sock
//   ORBI_DESKTOP_TOKEN_FILE the server's token, default
//                          ~/Library/Application Support/Orbi/desktop.token
//   ORBI_DESKTOP_DRY_RUN=1 no side effects at all: no menu bar item, no
//                          overlay, no hotkey, no mic, no input, no capture,
//                          no app activation; every permission reports false
//   ORBI_DESKTOP_NO_MIC=1, ORBI_DESKTOP_NO_SCREEN=1  turn one off
//   ORBI_DESKTOP_LOG=1     log to stderr (never text typed or heard)
enum Env {
  static let vars = ProcessInfo.processInfo.environment
  static func flag(_ k: String) -> Bool { ["1", "true", "yes"].contains((vars[k] ?? "").lowercased()) }

  static let dryRun = flag("ORBI_DESKTOP_DRY_RUN")
  static let noMic = dryRun || flag("ORBI_DESKTOP_NO_MIC")
  static let noScreen = dryRun || flag("ORBI_DESKTOP_NO_SCREEN")
  static let logging = flag("ORBI_DESKTOP_LOG") || dryRun
  static let socketPath = vars["ORBI_DESKTOP_SOCKET"].flatMap { $0.isEmpty ? nil : $0 }
    ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Orbi/desktop.sock").path
  // Made by the server at startup (64 hex characters, mode 0600); read
  // fresh on every connect and sent in hello.
  static let tokenFile = vars["ORBI_DESKTOP_TOKEN_FILE"].map { URL(fileURLWithPath: $0) }
    ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Orbi/desktop.token")

  static func token() -> String? {
    guard let s = try? String(contentsOf: tokenFile, encoding: .utf8) else { return nil }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
  }
}

func log(_ s: @autoclosure () -> String) {
  guard Env.logging else { return }
  FileHandle.standardError.write(Data("[orbi-desktop] \(s())\n".utf8))
}

// What the user has granted. The helper never changes these; the
// Permissions window only opens the right System Settings pane.
enum Perms {
  static var accessibility: Bool { !Env.dryRun && AXIsProcessTrusted() }
  static var screen: Bool { !Env.noScreen && CGPreflightScreenCaptureAccess() }
  static var mic: Bool { !Env.noMic && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
  static var input: Bool { accessibility } // posting CGEvents needs Accessibility

  static var current: Permissions { Permissions(accessibility: accessibility, screen: screen, mic: mic) }

  enum Pane: String {
    case accessibility = "Privacy_Accessibility"
    case screen = "Privacy_ScreenCapture"
    case mic = "Privacy_Microphone"
  }

  static func open(_ pane: Pane) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)") {
      NSWorkspace.shared.open(url)
    }
  }

  // The system's own prompts, shown only when the user asks from the
  // Permissions window. They add Orbi Desktop to the list; the user still
  // switches it on.
  static func prompt(_ pane: Pane) {
    switch pane {
    case .accessibility:
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(opts)
    case .screen:
      _ = CGRequestScreenCaptureAccess()
    case .mic:
      AVCaptureDevice.requestAccess(for: .audio) { _ in }
    }
  }
}

// The screen is locked: nothing may act or look.
func screenLocked() -> Bool {
  guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (d["CGSSessionScreenIsLocked"] as? Bool) ?? ((d["CGSSessionScreenIsLocked"] as? Int) == 1)
}
