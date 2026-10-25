import Foundation

// Apps the helper never acts on, whatever the server asks. An entry blocks
// that bundle id and every id under it ("com.google.Chrome" also blocks
// com.google.Chrome.canary and Chrome's helpers). Matching ignores case.
// Chrome stays the extension's job, so its DOM locks can't be bypassed from
// the desktop.
public struct Blocklist: Sendable {
  public static let builtIn: [String] = [
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.1password",             // 1Password 8 (com.1password.1password) and its helpers
    "com.agilebits.onepassword", // 1Password 7 and older
    "com.agilebits.onepassword7",
    "com.agilebits.onepassword-osx",
    "com.bitwarden.desktop",
    "com.apple.systempreferences", // System Settings and System Preferences
    "com.apple.settings",
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.google.Chrome",
  ]

  private let builtInIds: [String]
  public private(set) var serverIds: [String] = []

  public init() {
    builtInIds = Self.builtIn.map { $0.lowercased() }
  }

  // Replaces the server's extra entries; the built-in list always applies.
  public mutating func setServerEntries(_ ids: [String]) {
    serverIds = ids.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
  }

  // Unknown (nil or empty) ids are not blocked by this check; callers that
  // cannot tell which app they would act on must refuse on their own.
  public func isBlocked(_ bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased(), !id.isEmpty else { return false }
    for entry in builtInIds + serverIds {
      if id == entry || id.hasPrefix(entry + ".") { return true }
    }
    return false
  }
}
