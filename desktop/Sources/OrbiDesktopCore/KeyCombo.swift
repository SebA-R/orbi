import Foundation

// "cmd+shift+4" -> the virtual key code and modifiers to post. Modifiers are
// cmd|command, shift, alt|option|opt, ctrl|control, fn, in any order, joined
// with "+", followed by exactly one key. Case does not matter. "cmd++" and
// "cmd+plus" both mean the + key (shift and =).
public struct Modifiers: OptionSet, Hashable, Sendable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }
  public static let cmd = Modifiers(rawValue: 1)
  public static let shift = Modifiers(rawValue: 2)
  public static let alt = Modifiers(rawValue: 4)
  public static let ctrl = Modifiers(rawValue: 8)
  public static let fn = Modifiers(rawValue: 16)
}

public struct KeyCombo: Equatable, Sendable {
  public let keyCode: UInt16
  public let modifiers: Modifiers
  public init(keyCode: UInt16, modifiers: Modifiers) {
    self.keyCode = keyCode
    self.modifiers = modifiers
  }
}

// Virtual key codes (Carbon kVK_*), US ANSI positions.
public enum KeyCode {
  public static let returnKey: UInt16 = 36
  public static let tab: UInt16 = 48
  public static let space: UInt16 = 49
  public static let delete: UInt16 = 51
  public static let escape: UInt16 = 53
  public static let rightOption: UInt16 = 61

  public static let letters: [Character: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
    "k": 40, "n": 45, "m": 46,
  ]
  public static let digits: [Character: UInt16] = [
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
  ]
  public static let punctuation: [Character: UInt16] = [
    "=": 24, "-": 27, "]": 30, "[": 33, "'": 39, ";": 41, "\\": 42, ",": 43, "/": 44, ".": 47, "`": 50,
  ]
  public static let named: [String: UInt16] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "minus": 27, "equal": 24, "comma": 43, "period": 47, "slash": 44, "semicolon": 41, "quote": 39,
    "backslash": 42, "grave": 50, "leftbracket": 33, "rightbracket": 30,
  ]
}

private let modifierNames: [String: Modifiers] = [
  "cmd": .cmd, "command": .cmd, "meta": .cmd, "shift": .shift, "alt": .alt, "option": .alt, "opt": .alt,
  "ctrl": .ctrl, "control": .ctrl, "fn": .fn,
]

public func parseKeyCombo(_ input: String) throws -> KeyCombo {
  let bad = { (why: String) in ProtoError(.badRequest, "combo \(why)") }
  var s = input.trimmingCharacters(in: .whitespaces).lowercased()
  guard !s.isEmpty, s.count <= 64 else { throw bad("is empty or too long") }
  // A trailing "++" (or the whole combo "+") is the plus key itself.
  var plusKey = false
  if s == "+" { plusKey = true; s = "" }
  else if s.hasSuffix("++") { plusKey = true; s = String(s.dropLast(2)) }

  var parts = s.isEmpty ? [] : s.split(separator: "+", omittingEmptySubsequences: false).map {
    $0.trimmingCharacters(in: .whitespaces)
  }
  if parts.contains(where: \.isEmpty) { throw bad("has an empty part") }
  var keyName: String? = plusKey ? "plus" : nil
  if keyName == nil {
    guard let last = parts.popLast() else { throw bad("has no key") }
    keyName = last
  }
  var mods: Modifiers = []
  for p in parts {
    guard let m = modifierNames[p] else { throw bad("has an unknown modifier \(p)") }
    guard !mods.contains(m) else { throw bad("repeats \(p)") }
    mods.insert(m)
  }
  guard let name = keyName else { throw bad("has no key") }
  if name == "plus" { return KeyCombo(keyCode: 24, modifiers: mods.union(.shift)) }
  if modifierNames[name] != nil { throw bad("has no key after the modifiers") }
  if let code = KeyCode.named[name] { return KeyCombo(keyCode: code, modifiers: mods) }
  if name.count == 1, let ch = name.first {
    if let code = KeyCode.letters[ch] ?? KeyCode.digits[ch] ?? KeyCode.punctuation[ch] {
      return KeyCombo(keyCode: code, modifiers: mods)
    }
  }
  throw bad("has an unknown key \(name)")
}

// Shifted characters, by the unshifted key they sit on (US layout).
private let shifted: [Character: Character] = [
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
]

// The physical US key for a typed character, or nil when there is no single
// key for it (accents, emoji): those are posted as text only.
public func usKey(for ch: Character) -> (code: UInt16, shift: Bool)? {
  if ch == " " { return (KeyCode.space, false) }
  if ch == "\n" || ch == "\r" || ch == "\r\n" { return (KeyCode.returnKey, false) }
  if ch == "\t" { return (KeyCode.tab, false) }
  var base = ch, shift = false
  if ch.isASCII, ch.isUppercase, let lower = ch.lowercased().first { base = lower; shift = true }
  else if let b = shifted[ch] { base = b; shift = true }
  guard let code = KeyCode.letters[base] ?? KeyCode.digits[base] ?? KeyCode.punctuation[base] else { return nil }
  return (code, shift)
}
