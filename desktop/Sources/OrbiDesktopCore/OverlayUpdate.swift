import Foundation

// The overlay request's params, checked. Version 1 sent
//   {state, subtitle?, cursor?:{x,y}, ring?: bool or {x,y,w,h}}
// and "overlay2" (a hello feature) adds, all optional:
//   state     may be left out: the state stays as it is
//   latched   true while listening hands free (the card's latch hint)
//   line      {speaker: "user"|"agent", text, final?}: a caption shown now
//   speech    {id, text?, timestamps?, phonemes?, done?}: an agent line Sonic
//             is speaking. text queues it (the audio that follows is its);
//             timestamps {words, start, end} and phonemes {phonemes, start,
//             end} are Sonic's, in seconds of the line's audio; done says
//             all its audio has been sent
//   cue       an earcon: listen, sent, cut, error, placed, failed, closed
//   ring      a frame may carry label, the target's name, for the cursor's
//             "Clicking ..." line
// A v1 subtitle has no speaker: it is the user's while listening or
// thinking and the agent's otherwise, which is how v1 servers sent it.
public struct OverlayUpdate: Equatable, Sendable {
  public enum State: String, Sendable { case idle, listening, thinking, speaking }

  public struct Line: Equatable, Sendable {
    public var speaker: String
    public var text: String
    public var final: Bool
  }

  public struct Target: Equatable, Sendable {
    public var x, y, w, h: Double
    public var label: String?
  }

  public static let cues: Set<String> = ["listen", "sent", "cut", "error", "placed", "failed", "closed"]
  static let maxText = 4000
  static let maxStamps = 4000

  public var state: State?
  public var latched: Bool?
  public var line: Line?
  public var speech: JSON?
  public var cue: String?
  public var cursor: Point?
  public var ring: Bool?
  public var target: Target?

  public init() {}

  public static func parse(_ p: Params) throws -> OverlayUpdate {
    var u = OverlayUpdate()
    if let raw = try p.optString("state") {
      guard let s = State(rawValue: raw) else { throw ProtoError(.badRequest, "state must be idle, listening, thinking or speaking") }
      u.state = s
    }
    u.latched = try p.optBool("latched")
    if let c = try p.point("cursor") { u.cursor = Point(x: c.x, y: c.y) }
    if let o = p.raw["ring"]?.object {
      let f = Params(o)
      let (x, y, w, h) = (try f.number("x"), try f.number("y"), try f.number("w"), try f.number("h"))
      guard w > 0, h > 0 else { throw ProtoError(.badRequest, "ring frame must have a positive size") }
      u.target = Target(x: x, y: y, w: w, h: h, label: try f.optString("label").map { String($0.prefix(80)) })
    } else {
      u.ring = try p.optBool("ring")
    }
    if let o = p.raw["line"] {
      guard let l = o.object else { throw ProtoError(.badRequest, "line must be {speaker, text, final?}") }
      let f = Params(l)
      let speaker = try f.string("speaker")
      guard speaker == "user" || speaker == "agent" else { throw ProtoError(.badRequest, "line.speaker must be user or agent") }
      u.line = Line(speaker: speaker, text: String(try f.string("text").prefix(maxText)), final: try f.optBool("final") ?? false)
    } else if let s = try p.optString("subtitle"), !s.isEmpty {
      let user = u.state == .listening || u.state == .thinking
      u.line = Line(speaker: user ? "user" : "agent", text: String(s.prefix(maxText)), final: !(u.state == .listening))
    }
    if let o = p.raw["speech"] { u.speech = try speech(o) }
    if let c = try p.optString("cue") {
      guard cues.contains(c) else { throw ProtoError(.badRequest, "unknown cue \(c)") }
      u.cue = c
    }
    return u
  }

  // Only the fields the overlay reads, each checked, so nothing else
  // reaches the web view.
  static func speech(_ v: JSON) throws -> JSON {
    guard let o = v.object else { throw ProtoError(.badRequest, "speech must be an object") }
    let f = Params(o)
    let id = try f.string("id")
    guard (1...64).contains(id.count), id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
      throw ProtoError(.badRequest, "speech.id must be 1 to 64 letters, digits, - or _")
    }
    var out: [String: JSON] = ["id": .string(id)]
    if let t = try f.optString("text") { out["text"] = .string(String(t.prefix(maxText))) }
    if let d = try f.optBool("done") { out["done"] = .bool(d) }
    for (key, names) in [("timestamps", "words"), ("phonemes", "phonemes")] {
      guard let raw = o[key], raw != .null else { continue }
      guard let ts = raw.object, let n = ts[names]?.array, let s = ts["start"]?.array, let e = ts["end"]?.array,
            n.count == s.count, s.count == e.count, n.count <= maxStamps,
            n.allSatisfy({ $0.string != nil }), (s + e).allSatisfy({ $0.double != nil }) else {
        throw ProtoError(.badRequest, "speech.\(key) must be {\(names), start, end}: equal lists of strings and numbers")
      }
      out[key] = .object([names: .array(n.map { .string(String($0.string!.prefix(64))) }), "start": .array(s), "end": .array(e)])
    }
    return .object(out)
  }

  // What the web overlay's orbi.apply gets (desktop/Resources/overlay/bridge.js).
  public func webJSON(frame: Bool?) -> JSON {
    var o: [String: JSON] = [:]
    if let state { o["state"] = .string(state.rawValue) }
    if let latched { o["latched"] = .bool(latched) }
    if let line { o["line"] = ["speaker": .string(line.speaker), "text": .string(line.text), "final": .bool(line.final)] }
    if let speech { o["speech"] = speech }
    if let cue { o["cue"] = .string(cue) }
    if let frame { o["frame"] = .bool(frame) }
    if let t = target {
      o["target"] = ["x": JSON(t.x), "y": JSON(t.y), "w": JSON(t.w), "h": JSON(t.h), "label": JSON(t.label)]
    }
    return .object(o)
  }
}
