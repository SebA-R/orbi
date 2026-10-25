import XCTest
@testable import OrbiDesktopCore

final class LuhnRedactionTests: XCTestCase {
  private func line(_ s: String, y: Double = 0) -> TextLine { TextLine(text: s, box: Box(x: 0, y: y, w: 300, h: 20)) }
  private func hitText(_ lines: [TextLine]) -> [String] {
    Redaction.hits(in: lines).map { String(lines[$0.line].text[$0.range]) }
  }

  func testLuhn() {
    XCTAssertTrue(Luhn.valid("4111111111111111"))
    XCTAssertTrue(Luhn.valid("4111 1111 1111 1111"))
    XCTAssertTrue(Luhn.valid("378282246310005")) // Amex, 15
    XCTAssertFalse(Luhn.valid("4111111111111112"))
    XCTAssertFalse(Luhn.valid(""))
    XCTAssertFalse(Luhn.valid("41111x1111111111"))
  }

  func testCardNumbersWithSeparators() {
    XCTAssertEqual(hitText([line("Card 4111 1111 1111 1111 exp 12/29")]), ["4111 1111 1111 1111"])
    XCTAssertEqual(hitText([line("5555-5555-5555-4444")]), ["5555-5555-5555-4444"])
    XCTAssertEqual(hitText([line("amex 378282246310005.")]), ["378282246310005"])
    XCTAssertEqual(hitText([line("6011111111111117")]), ["6011111111111117"])
    // OCR's doubled spaces still join.
    XCTAssertEqual(hitText([line("4111  1111 1111  1111")]), ["4111  1111 1111  1111"])
  }

  func testNonCardsAreLeftAlone() {
    XCTAssertTrue(hitText([line("Order 1234567890123")]).isEmpty) // 13 digits, fails Luhn
    XCTAssertTrue(hitText([line("Call 555 123 4567")]).isEmpty) // 10 digits
    XCTAssertTrue(hitText([line("Total 1,234,567.89")]).isEmpty)
    // Three separators in a row split runs: neither half is a card.
    XCTAssertTrue(hitText([line("41111111 - 11111111")]).isEmpty)
  }

  func testCardJoinedToNeighbours() {
    // An expiry, CVC or other digits a space joined onto the card.
    XCTAssertEqual(hitText([line("5555 5555 5555 4444 05/27")]), ["5555 5555 5555 4444 05"])
    XCTAssertEqual(hitText([line("4242 4242 4242 4242 123")]), ["4242 4242 4242 4242 123"])
    XCTAssertEqual(hitText([line("4111111111111111 12")]), ["4111111111111111 12"])
  }

  func testLongRunCoveredIfAnyWindowPasses() {
    // A card glued to extra digits by OCR.
    let hits = hitText([line("41111111111111119876")])
    XCTAssertEqual(hits, ["41111111111111119876"])
  }

  func testOneTimeCodes() {
    XCTAssertEqual(hitText([line("Your verification code is 482913")]), ["482913"])
    XCTAssertEqual(hitText([line("Code: 482-913")]), ["482-913"])
    XCTAssertEqual(hitText([line("Enter OTP 482 913")]), ["482 913"])
    // On a nearby line.
    XCTAssertEqual(hitText([line("Verification", y: 0), line("482913", y: 25)]), ["482913"])
    // Next to other digits.
    XCTAssertEqual(hitText([line("Your code: 123456 2024")]), ["123456"])
  }

  func testSixDigitsWithoutContextOrNotStandalone() {
    XCTAssertTrue(hitText([line("Invoice 482913")]).isEmpty)
    XCTAssertTrue(hitText([line("code A482913")]).isEmpty)
    XCTAssertTrue(hitText([line("code 4829130")]).isEmpty)
    // A keyword far away does not count.
    XCTAssertTrue(hitText([line("code", y: 0), line("482913", y: 500)]).isEmpty)
  }
}

final class KeyComboTests: XCTestCase {
  func testBasics() throws {
    XCTAssertEqual(try parseKeyCombo("cmd+shift+4"), KeyCombo(keyCode: 21, modifiers: [.cmd, .shift]))
    XCTAssertEqual(try parseKeyCombo("Return"), KeyCombo(keyCode: 36, modifiers: []))
    XCTAssertEqual(try parseKeyCombo("ctrl+alt+Delete"), KeyCombo(keyCode: 51, modifiers: [.ctrl, .alt]))
    XCTAssertEqual(try parseKeyCombo("option+left"), KeyCombo(keyCode: 123, modifiers: [.alt]))
    XCTAssertEqual(try parseKeyCombo("cmd+,"), KeyCombo(keyCode: 43, modifiers: [.cmd]))
    XCTAssertEqual(try parseKeyCombo("f12"), KeyCombo(keyCode: 111, modifiers: []))
    XCTAssertEqual(try parseKeyCombo(" command + a "), KeyCombo(keyCode: 0, modifiers: [.cmd]))
    XCTAssertEqual(try parseKeyCombo("cmd+space"), KeyCombo(keyCode: 49, modifiers: [.cmd]))
  }

  func testPlus() throws {
    XCTAssertEqual(try parseKeyCombo("cmd++"), KeyCombo(keyCode: 24, modifiers: [.cmd, .shift]))
    XCTAssertEqual(try parseKeyCombo("cmd+plus"), KeyCombo(keyCode: 24, modifiers: [.cmd, .shift]))
    XCTAssertEqual(try parseKeyCombo("+"), KeyCombo(keyCode: 24, modifiers: [.shift]))
  }

  func testRejects() {
    for bad in ["", "cmd+", "cmd+shift", "cmd+cmd+a", "hyper+a", "a+b", "cmd+ab", "cmd++a", "f13", String(repeating: "a", count: 80)] {
      XCTAssertThrowsError(try parseKeyCombo(bad), bad) { e in
        XCTAssertEqual((e as? ProtoError)?.code, .badRequest)
      }
    }
  }

  func testUSKeys() {
    XCTAssertEqual(usKey(for: "a")?.code, 0)
    XCTAssertEqual(usKey(for: "A")?.shift, true)
    XCTAssertEqual(usKey(for: "!")?.code, 18)
    XCTAssertEqual(usKey(for: "!")?.shift, true)
    XCTAssertEqual(usKey(for: "\n")?.code, 36)
    XCTAssertNil(usKey(for: "é"))
  }
}

final class ProtocolTests: XCTestCase {
  func testHelloAndEvents() throws {
    let hello = try JSON.decode(Outbound.hello(Permissions(accessibility: true, screen: false, mic: true), nonce: "n1"))
    XCTAssertEqual(hello["nonce"], "n1")
    XCTAssertNil(hello["token"])
    XCTAssertEqual(hello["features"], ["element", "focused", "expectRef", "exclude"])
    XCTAssertEqual(hello["type"], "hello")
    XCTAssertEqual(hello["name"], "orbi-desktop")
    XCTAssertEqual(hello["version"], 1)
    XCTAssertEqual(hello["permissions"]?["screen"], false)
    XCTAssertEqual(hello["permissions"]?["accessibility"], true)
    XCTAssertEqual(try JSON.decode(Outbound.event(.latchToggle)), ["type": "event", "name": "latch_toggle"])
  }

  func testHandshakeVectorsMatchTheServer() throws {
    // Same vectors as agent/test/desktop.test.ts.
    let token = String(repeating: "ab", count: 32), hn = String(repeating: "01", count: 32), sn = String(repeating: "02", count: 32)
    let server = Handshake.serverProof(token: token, helperNonce: hn, serverNonce: sn)
    XCTAssertEqual(server, "7d46559683f397d70ec8e45465080ec9b7557ad68430e55a5829e63d39c5e0ab")
    XCTAssertEqual(Handshake.helperProof(token: token, serverNonce: sn, helperNonce: hn),
                   "83ebbb5f69b3e568dbdef5bded7af8a37e2e967972decb3ed1b10e9525bee479")
    XCTAssertTrue(Handshake.matches(server, server))
    XCTAssertFalse(Handshake.matches(server, String(repeating: "0", count: 64)))
    XCTAssertFalse(Handshake.matches(server, "short"))
    let n = Handshake.nonce()
    XCTAssertTrue(Handshake.isHex64(n))
    XCTAssertNotEqual(n, Handshake.nonce())
    XCTAssertEqual(try decodeInbound(#"{"type":"challenge","nonce":"a","proof":"b"}"#), .challenge(nonce: "a", proof: "b"))
    XCTAssertEqual(try JSON.decode(Outbound.auth(proof: "p")), ["type": "auth", "proof": "p"])
  }

  func testResultAndErrorEchoId() throws {
    let r = try JSON.decode(Outbound.result(id: 7, ["ok": true]))
    XCTAssertEqual(r, ["type": "res", "id": 7, "result": ["ok": true]])
    let e = try JSON.decode(Outbound.error(id: "a1", ProtoError(.blockedApp, "no")))
    XCTAssertEqual(e, ["type": "res", "id": "a1", "error": ["code": "blocked_app", "message": "no"]])
  }

  func testDecodeRequests() throws {
    XCTAssertEqual(try decodeInbound(#"{"type":"req","id":3,"method":"click","params":{"x":10,"y":20.5}}"#),
                   .request(id: 3, method: "click", params: ["x": 10, "y": 20.5]))
    XCTAssertEqual(try decodeInbound(#"{"type":"req","id":"q","method":"frontmost"}"#),
                   .request(id: "q", method: "frontmost", params: [:]))
    XCTAssertEqual(try decodeInbound(#"{"type":"req","id":4,"params":{}}"#), .badRequest(id: 4, message: "method missing"))
    XCTAssertEqual(try decodeInbound(#"{"type":"req","id":5,"method":"key","params":[1]}"#),
                   .badRequest(id: 5, message: "params must be an object"))
    XCTAssertThrowsError(try decodeInbound(#"{"type":"req","method":"key"}"#))
    XCTAssertThrowsError(try decodeInbound("not json"))
    XCTAssertThrowsError(try decodeInbound("[1,2]"))
    XCTAssertThrowsError(try decodeInbound(#"{"id":1}"#))
  }

  func testDecodeServerMessages() throws {
    XCTAssertEqual(try decodeInbound(#"{"type":"welcome","version":1}"#), .welcome(version: 1, blockedApps: nil))
    XCTAssertEqual(try decodeInbound(#"{"type":"welcome","version":1,"blockedApps":["com.a", 3, " ", "com.b "]}"#),
                   .welcome(version: 1, blockedApps: ["com.a", "com.b"]))
    XCTAssertEqual(try decodeInbound(#"{"type":"config","blockedApps":["x.y"]}"#), .config(blockedApps: ["x.y"]))
    XCTAssertEqual(try decodeInbound(#"{"type":"audio_stop"}"#), .audioStop)
    XCTAssertEqual(try decodeInbound(#"{"type":"later"}"#), .unknown(type: "later"))
  }

  func testParams() throws {
    let p = Params(["x": 1, "y": "2", "n": 3.5, "b": true, "cursor": ["x": 4, "y": 5]])
    XCTAssertThrowsError(try p.point()) // y is a string
    XCTAssertEqual(try p.point("cursor")?.x, 4)
    XCTAssertThrowsError(try p.int("n", default: 1, range: 1...10))
    XCTAssertEqual(try p.int("missing", default: 150, range: 1...500), 150)
    XCTAssertEqual(try p.optBool("b"), true)
    XCTAssertNil(try p.optString("missing"))
  }
}

final class BlocklistTests: XCTestCase {
  func testBuiltIn() {
    let b = Blocklist()
    for id in ["com.apple.keychainaccess", "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
               "com.apple.systempreferences", "com.apple.Terminal", "com.googlecode.iterm2", "com.google.Chrome",
               "com.google.Chrome.canary", "com.google.chrome.helper", "COM.APPLE.TERMINAL", "com.apple.Passwords"] {
      XCTAssertTrue(b.isBlocked(id), id)
    }
    for id in ["com.apple.finder", "com.apple.Safari", "com.google.Chromecast", "com.apple.Terminals", "", nil] as [String?] {
      XCTAssertFalse(b.isBlocked(id), id ?? "nil")
    }
  }

  func testServerEntriesAddButNeverRemove() {
    var b = Blocklist()
    b.setServerEntries(["com.tinyspeck.slackmacgap", " "])
    XCTAssertTrue(b.isBlocked("com.tinyspeck.slackmacgap"))
    b.setServerEntries([])
    XCTAssertFalse(b.isBlocked("com.tinyspeck.slackmacgap"))
    XCTAssertTrue(b.isBlocked("com.apple.Terminal"))
  }
}

final class HumanizeTests: XCTestCase {
  func testPathEndsExactly() {
    var rng = Rng(seed: 42)
    for _ in 0..<50 {
      let from = Point(x: rng.between(0, 2000), y: rng.between(0, 1200))
      let to = Point(x: rng.between(0, 2000), y: rng.between(0, 1200))
      let path = planPath(from: from, to: to, rng: &rng)
      XCTAssertEqual(path.first?.x, from.x)
      XCTAssertEqual(path.last?.x, to.x)
      XCTAssertEqual(path.last?.y, to.y)
    }
  }

  func testTypingKeepsText() {
    var rng = Rng(seed: 1)
    let text = "Hello, world! 123 é"
    let plan = planTyping(text, rng: &rng)
    XCTAssertEqual(String(plan.map(\.ch)), text)
    XCTAssertEqual(plan.first?.gapMs, 0)
  }

  func testScrollSumsExactly() {
    var rng = Rng(seed: 9)
    let steps = planScroll(dx: -37, dy: 913, rng: &rng)
    XCTAssertEqual(steps.reduce(0) { $0 + $1.dy }, 913)
    XCTAssertEqual(steps.reduce(0) { $0 + $1.dx }, -37)
  }
}

final class PushToTalkTests: XCTestCase {
  func testHoldSendsDownAndUp() {
    var m = PushToTalk()
    XCTAssertEqual(m.down(at: 0), [.micOpen])
    XCTAssertEqual(m.tick(at: 100), [])
    XCTAssertEqual(m.tick(at: 200), [.send(.pttDown), .micStream, .stopPlayback])
    XCTAssertEqual(m.up(at: 900), [.micClose, .send(.pttUp)])
    XCTAssertEqual(m.state, .idle)
  }

  func testTapSendsNothingAndDoubleTapLatches() {
    var m = PushToTalk()
    _ = m.down(at: 0)
    XCTAssertEqual(m.up(at: 80), [.micClose])
    XCTAssertEqual(m.down(at: 300), [.micOpen, .micStream, .send(.latchToggle), .stopPlayback])
    XCTAssertEqual(m.up(at: 380), [])
    XCTAssertEqual(m.down(at: 5000), [.micClose, .send(.latchToggle)])
    XCTAssertEqual(m.up(at: 5100), [])
    XCTAssertEqual(m.state, .idle)
  }

  func testSlowSecondTapIsANewPress() {
    var m = PushToTalk()
    _ = m.down(at: 0)
    _ = m.up(at: 80)
    XCTAssertEqual(m.down(at: 1000), [.micOpen])
  }

  func testLatchTimesOut() {
    var m = PushToTalk(maxLatchMs: 1000)
    _ = m.down(at: 0); _ = m.up(at: 50); _ = m.down(at: 100); _ = m.up(at: 150)
    XCTAssertEqual(m.tick(at: 1200), [.micClose, .send(.latchToggle)])
    XCTAssertEqual(m.state, .idle)
  }
}
