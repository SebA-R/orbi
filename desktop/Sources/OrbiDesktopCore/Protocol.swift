import CryptoKit
import Foundation

// Protocol v1 between the helper (client) and the Orbi server, over a Unix
// domain socket (Frames.swift). JSON frames; binary frames carry audio (mic
// PCM s16le 16 kHz mono up, TTS PCM s16le 24 kHz mono down).
//
// Coordinates everywhere are global screen points, top-left origin of the
// main display (the Quartz/AX space).
public enum Proto {
  public static let version = 1
  public static let name = "orbi-desktop"
  public static let features = ["element", "focused", "expectRef", "exclude", "overlay2"]
  public static let micSampleRate = 16_000.0
  public static let ttsSampleRate = 24_000.0
}

public enum ErrorCode: String, Sendable, CaseIterable {
  case badRequest = "bad_request"
  case unknownMethod = "unknown_method"
  case noPermission = "no_permission"
  case noElement = "no_element"
  case blockedApp = "blocked_app"
  case locked = "locked"
  case staleRef = "stale_ref"           // a ref that is unknown, from an old snapshot, or gone
  case targetChanged = "target_changed" // what is under the point or focused is not what was checked
  case secureField = "secure_field"     // typing would go to a password field
  case internalError = "internal"
}

// A failure a method handler reports back to the server as {code, message}.
public struct ProtoError: Error, Equatable, Sendable {
  public let code: ErrorCode
  public let message: String
  public init(_ code: ErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }
}

public enum ProtoMethod: String, Sendable, CaseIterable {
  case frontmost, apps_list, app_activate, ax_tree, element, element_at, focused
  case click, type, key, scroll, screenshot, overlay
}

public struct Permissions: Equatable, Sendable {
  public var accessibility: Bool
  public var screen: Bool
  public var mic: Bool
  public init(accessibility: Bool, screen: Bool, mic: Bool) {
    self.accessibility = accessibility
    self.screen = screen
    self.mic = mic
  }
}

public enum PTTEvent: String, Sendable {
  case pttDown = "ptt_down"
  case pttUp = "ptt_up"
  case latchToggle = "latch_toggle"
}

// What the server can send.
public enum Inbound: Equatable, Sendable {
  case challenge(nonce: String, proof: String)
  case welcome(version: Int, blockedApps: [String]?)
  case config(blockedApps: [String]?)
  case request(id: JSON, method: String, params: [String: JSON])
  // A request we can still answer, but whose shape is wrong.
  case badRequest(id: JSON, message: String)
  case audioStop
  case unknown(type: String)
}

public enum Outbound {
  // The token itself is never sent: hello carries our nonce, and auth our
  // proof (see Handshake).
  public static func hello(_ p: Permissions, nonce: String) -> String {
    JSON.object([
      "type": "hello", "name": .string(Proto.name), "version": JSON(Proto.version), "nonce": .string(nonce),
      "features": .array(Proto.features.map { .string($0) }),
      "permissions": ["accessibility": .bool(p.accessibility), "screen": .bool(p.screen), "mic": .bool(p.mic)],
    ]).encoded()
  }

  public static func result(id: JSON, _ result: JSON) -> String {
    JSON.object(["type": "res", "id": id, "result": result]).encoded()
  }

  public static func error(id: JSON, _ e: ProtoError) -> String {
    JSON.object(["type": "res", "id": id, "error": ["code": .string(e.code.rawValue), "message": .string(e.message)]]).encoded()
  }

  public static func auth(proof: String) -> String {
    JSON.object(["type": "auth", "proof": .string(proof)]).encoded()
  }

  public static func event(_ e: PTTEvent) -> String {
    JSON.object(["type": "event", "name": .string(e.rawValue)]).encoded()
  }
}

public enum ProtoDecodeError: Error, Equatable {
  case notJSON
  case notObject
  case missingType
  case requestWithoutId
}

// Blocked app ids from the server: strings only, trimmed, empties dropped.
// Anything that is not a list of strings counts as absent.
private func blockedList(_ v: JSON?) -> [String]? {
  guard let a = v?.array else { return nil }
  return a.compactMap { $0.string?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

public func decodeInbound(_ text: String) throws -> Inbound {
  guard let msg = try? JSON.decode(text) else { throw ProtoDecodeError.notJSON }
  guard msg.object != nil else { throw ProtoDecodeError.notObject }
  guard let type = msg["type"]?.string else { throw ProtoDecodeError.missingType }
  switch type {
  case "challenge":
    return .challenge(nonce: msg["nonce"]?.string ?? "", proof: msg["proof"]?.string ?? "")
  case "welcome":
    return .welcome(version: msg["version"]?.int ?? 0, blockedApps: blockedList(msg["blockedApps"]))
  case "config":
    return .config(blockedApps: blockedList(msg["blockedApps"]))
  case "audio_stop":
    return .audioStop
  case "req":
    guard let id = msg["id"], id.string != nil || id.double != nil else { throw ProtoDecodeError.requestWithoutId }
    guard let method = msg["method"]?.string, !method.isEmpty else { return .badRequest(id: id, message: "method missing") }
    let params: [String: JSON]
    switch msg["params"] {
    case nil, .some(.null): params = [:]
    case .some(.object(let o)): params = o
    default: return .badRequest(id: id, message: "params must be an object")
    }
    return .request(id: id, method: method, params: params)
  default:
    return .unknown(type: type)
  }
}

// Typed reads of request params. Each throws bad_request with a message
// that names the field.
public struct Params {
  public let raw: [String: JSON]
  public init(_ raw: [String: JSON]) { self.raw = raw }

  public func has(_ k: String) -> Bool {
    if let v = raw[k], v != .null { return true }
    return false
  }

  public func string(_ k: String) throws -> String {
    guard let s = raw[k]?.string else { throw ProtoError(.badRequest, "\(k) must be a string") }
    return s
  }

  public func optString(_ k: String) throws -> String? {
    guard has(k) else { return nil }
    return try string(k)
  }

  public func number(_ k: String) throws -> Double {
    guard let d = raw[k]?.double else { throw ProtoError(.badRequest, "\(k) must be a finite number") }
    return d
  }

  public func optNumber(_ k: String) throws -> Double? {
    guard has(k) else { return nil }
    return try number(k)
  }

  public func int(_ k: String, default d: Int, range: ClosedRange<Int>) throws -> Int {
    guard has(k) else { return d }
    guard let i = raw[k]?.int, range.contains(i) else {
      throw ProtoError(.badRequest, "\(k) must be an integer in \(range.lowerBound)...\(range.upperBound)")
    }
    return i
  }

  public func optBool(_ k: String) throws -> Bool? {
    guard has(k) else { return nil }
    guard let b = raw[k]?.bool else { throw ProtoError(.badRequest, "\(k) must be a boolean") }
    return b
  }

  // A point {x, y}, either at the top level or under a key.
  public func point(_ k: String? = nil) throws -> (x: Double, y: Double)? {
    let src: Params
    if let k {
      guard has(k) else { return nil }
      guard let o = raw[k]?.object else { throw ProtoError(.badRequest, "\(k) must be {x, y}") }
      src = Params(o)
    } else {
      guard has("x") || has("y") else { return nil }
      src = self
    }
    return (try src.number("x"), try src.number("y"))
  }
}

// Mutual proof of the shared token, without sending it:
//   hello {nonce: helperNonce}
//   challenge {nonce: serverNonce, proof: HMAC(token, "orbi-desktop server <helperNonce> <serverNonce>")}
//   auth {proof: HMAC(token, "orbi-desktop helper <serverNonce> <helperNonce>")}
// HMAC-SHA256 keyed with the token's characters, as lowercase hex. A
// server that cannot prove the token gets nothing but our nonce.
public enum Handshake {
  public static func nonce() -> String {
    var g = SystemRandomNumberGenerator() // arc4random: cryptographic
    return (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
  }

  static func hmac(_ token: String, _ msg: String) -> String {
    let mac = HMAC<SHA256>.authenticationCode(for: Data(msg.utf8), using: SymmetricKey(data: Data(token.utf8)))
    return mac.map { String(format: "%02x", $0) }.joined()
  }

  public static func serverProof(token: String, helperNonce: String, serverNonce: String) -> String {
    hmac(token, "orbi-desktop server \(helperNonce) \(serverNonce)")
  }

  public static func helperProof(token: String, serverNonce: String, helperNonce: String) -> String {
    hmac(token, "orbi-desktop helper \(serverNonce) \(helperNonce)")
  }

  static func isHex64(_ s: String) -> Bool {
    s.utf8.count == 64 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }

  // Constant time over the 64 characters.
  public static func matches(_ expected: String, _ sent: String) -> Bool {
    guard isHex64(expected), isHex64(sent) else { return false }
    var diff: UInt8 = 0
    for (a, b) in zip(expected.utf8, sent.utf8) { diff |= a ^ b }
    return diff == 0
  }
}
