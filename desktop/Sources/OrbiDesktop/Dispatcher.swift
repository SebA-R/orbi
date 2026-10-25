import AppKit
import Carbon.HIToolbox
import OrbiDesktopCore

// Answers the server's requests. Each handler validates its params first,
// then checks the blocklist, then permissions and the lock screen, and only
// then acts. Requests run one at a time in arrival order (an overlay update
// goes straight through), and a dropped connection cancels whatever is
// still queued or running.
//
// Defense in depth: blocked apps (Blocklist.builtIn plus the server's list)
// are refused here whatever the server asks. Clicks and scrolls check the
// app that owns the window under the point, keys and typing check the
// frontmost app, and both are checked again right before every press and
// key. Typing also refuses a focused secure field or secure keyboard entry,
// and stops if the focus moves to another element.
//
// Refs ("e12") are never reused while the helper runs, so a ref from an
// old snapshot can only be stale, never another element.
@MainActor
final class Dispatcher {
  var blocklist = Blocklist()
  var send: (String) -> Void = { _ in }

  private let overlay: Overlay
  private let input: Input
  private var refs: [String: AXNode] = [:]
  private var nextRef = 1
  private var tail: Task<Void, Never>?
  private var epoch = 0

  init(overlay: Overlay, input: Input) {
    self.overlay = overlay
    self.input = input
  }

  func reset() {
    epoch += 1
    tail = nil
    input.cancelAll()
    refs = [:]
  }

  func handle(id: JSON, method: String, params: [String: JSON]) {
    guard let m = ProtoMethod(rawValue: method) else {
      send(Outbound.error(id: id, ProtoError(.unknownMethod, "unknown method \(method)")))
      return
    }
    let p = Params(params)
    if m == .overlay {
      reply(id) { try self.overlayReq(p) }
      return
    }
    let prev = tail
    let started = epoch
    tail = Task { @MainActor in
      await prev?.value
      guard started == self.epoch else { return } // the connection that asked is gone
      let res: Result<JSON, ProtoError>
      do { res = .success(try await self.run(m, p)) }
      catch let e as ProtoError { res = .failure(e) }
      catch { res = .failure(ProtoError(.internalError, "\(error.localizedDescription)")) }
      guard started == self.epoch else { return }
      switch res {
      case .success(let r): self.send(Outbound.result(id: id, r))
      case .failure(let e): self.send(Outbound.error(id: id, e))
      }
    }
  }

  private func reply(_ id: JSON, _ body: () throws -> JSON) {
    do { send(Outbound.result(id: id, try body())) }
    catch let e as ProtoError { send(Outbound.error(id: id, e)) }
    catch { send(Outbound.error(id: id, ProtoError(.internalError, "\(error.localizedDescription)"))) }
  }

  private func run(_ m: ProtoMethod, _ p: Params) async throws -> JSON {
    switch m {
    case .frontmost: return frontmost()
    case .apps_list: return appsList()
    case .app_activate: return try appActivate(p)
    case .ax_tree: return try axTree(p)
    case .element: return try elementReq(p)
    case .element_at: return try elementAt(p)
    case .focused: return try focusedReq()
    case .click: return try await click(p)
    case .type: return try await type(p)
    case .key: return try await key(p)
    case .scroll: return try await scroll(p)
    case .screenshot: return try await screenshot(p)
    case .overlay: return try overlayReq(p)
    }
  }

  // ------------------------------------------------------------ guards

  private func bundleId(_ pid: pid_t) -> String? {
    NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
  }

  private var frontApp: NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

  private func refuseBlocked(_ id: String?, what: String) throws {
    if blocklist.isBlocked(id) { throw ProtoError(.blockedApp, "\(id ?? what) is off limits to Orbi") }
  }

  private func needAccessibility() throws {
    guard Perms.accessibility else { throw ProtoError(.noPermission, "Accessibility is not granted") }
  }

  private func needUnlocked() throws {
    if screenLocked() { throw ProtoError(.locked, "the screen is locked") }
  }

  private func needInput() throws {
    guard Perms.input else { throw ProtoError(.noPermission, "Accessibility is not granted, so Orbi cannot use the mouse or keyboard") }
  }

  // The app a click or scroll at p would reach: the owner of the frontmost
  // window under the point (not ours), or the frontmost app for the menu bar
  // and for points with no window.
  func targetBundleId(at p: CGPoint) -> String? { targetPid(at: p).flatMap(bundleId) }

  func targetPid(at p: CGPoint) -> pid_t? {
    let me = getpid()
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list {
      guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me,
            (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let b = w[kCGWindowBounds as String] as? NSDictionary,
            let r = CGRect(dictionaryRepresentation: b), r.contains(p) else { continue }
      if bundleId(pid) != nil { return pid }
      break // the Window Server's menu bar: the menus are the frontmost app's
    }
    return frontApp?.processIdentifier
  }

  // The element a press at p would reach, hit-tested inside the app that
  // owns the window there.
  private func hit(at p: CGPoint) -> AXNode? {
    guard let pid = targetPid(at: p) else { return nil }
    return AX.hitTest(x: p.x, y: p.y, pid: pid)
  }

  // Before any key or character: nothing goes to a blocked app, a password
  // field, or (when typing into a checked field) anywhere but that field.
  private func keysAllowed(secureCheck: Bool, focus: AXUIElement? = nil) throws {
    try needUnlocked()
    guard let front = frontApp else { throw ProtoError(.blockedApp, "no frontmost app") }
    try refuseBlocked(front.bundleIdentifier, what: "the frontmost app")
    // Keys go to the focused app, which a non-activating panel can make
    // differ from the frontmost one.
    if let pid = AX.focusedAppPid(), pid != front.processIdentifier {
      guard let id = bundleId(pid) else { throw ProtoError(.blockedApp, "Orbi cannot tell which app gets the keys") }
      try refuseBlocked(id, what: "the focused app")
    }
    guard secureCheck || focus != nil else { return }
    let now = AX.focusedElement()
    if secureCheck {
      if IsSecureEventInputEnabled() { throw ProtoError(.secureField, "secure keyboard entry is on (a password field has the focus)") }
      // Role and subrole only (never the value), on every key; an
      // unreadable role counts as secure.
      if let now, AX.string(now, kAXRoleAttribute) == nil
        || AX.isSecure(role: AX.string(now, kAXRoleAttribute), subrole: AX.string(now, kAXSubroleAttribute)) {
        throw ProtoError(.secureField, "the focused field is a password field")
      }
    }
    if let focus {
      guard let now, AX.same(now, orInside: focus) else { throw ProtoError(.targetChanged, "the focus moved to another element") }
    }
  }

  private func pointerAllowed(_ p: CGPoint, refPid: pid_t?) throws {
    try needUnlocked()
    if let refPid { try refuseBlocked(bundleId(refPid), what: "the element's app") }
    let unsure = ProtoError(.blockedApp, "Orbi cannot tell which app is under the pointer")
    guard let pid = targetPid(at: p), let id = bundleId(pid) else { throw unsure }
    try refuseBlocked(id, what: "the app under the pointer")
    // A second opinion from Accessibility's system-wide hit test, which
    // looks through click-through windows. It must agree with the window
    // list: no answer, or another app (another app's click-through overlay
    // over a blocked one, say), fails closed.
    var sys = AX.hitTest(x: p.x, y: p.y)
    // Our own overlay in the way: ask again with it out of the way.
    if sys?.pid == getpid() { sys = overlay.withoutWindow { AX.hitTest(x: p.x, y: p.y) } }
    guard let sys, sys.pid == pid else { throw unsure }
  }

  private func acting<T>(_ body: () async throws -> T) async rethrows -> T {
    overlay.beginAction()
    defer { overlay.endAction() }
    return try await body()
  }

  // ------------------------------------------------------------ refs

  private func register(_ n: AXNode) -> JSON {
    let ref = "e\(nextRef)"
    nextRef += 1
    refs[ref] = n
    // Bounded: past 3000 live refs the oldest go stale.
    if refs.count > 3000 {
      let cut = nextRef - 2000
      refs = refs.filter { (Int($0.key.dropFirst()) ?? 0) >= cut }
    }
    return n.json(ref: ref)
  }

  private func node(_ ref: String) throws -> AXNode {
    guard let n = refs[ref] else { throw ProtoError(.staleRef, "unknown or stale ref \(ref)") }
    guard AX.alive(n.element) else {
      refs[ref] = nil
      throw ProtoError(.staleRef, "\(ref) is gone")
    }
    return n
  }

  // A ref's live center and size, read again now (the element may have moved).
  private func resolve(_ ref: String) throws -> (point: CGPoint, size: Double, node: AXNode) {
    let n = try node(ref)
    guard let f = AX.frame(n.element), f.width > 0, f.height > 0, AX.onAnyScreen(f) else {
      throw ProtoError(.noElement, "\(ref) is not on screen")
    }
    return (CGPoint(x: f.midX, y: f.midY), Double(min(f.width, f.height)), n)
  }

  // {bundleId, appName, windowTitle, element, defaultButton?}: an element
  // with the app and window it is in, and the window's default button
  // (what Return would press).
  private func targetJSON(_ n: AXNode?, pid: pid_t) throws -> JSON {
    let app = NSRunningApplication(processIdentifier: pid)
    try refuseBlocked(app?.bundleIdentifier, what: "the element's app")
    guard let id = app?.bundleIdentifier else { throw ProtoError(.noElement, "that element belongs to no app") }
    let window = AX.window(of: n?.element, pid: pid)
    var o: [String: JSON] = [
      "bundleId": .string(id), "appName": JSON(app?.localizedName),
      "windowTitle": JSON(window.flatMap { AX.string($0, kAXTitleAttribute) }),
      "element": n.map(register) ?? .null,
    ]
    if let b = AX.defaultButton(in: window) { o["defaultButton"] = register(AX.node(b, pid: pid)) }
    return .object(o)
  }

  // ------------------------------------------------------------ methods

  private func frontmost() -> JSON {
    guard let app = frontApp else { return ["bundleId": nil, "appName": nil, "windowTitle": nil] }
    let id = app.bundleIdentifier
    var o: [String: JSON] = ["bundleId": JSON(id), "appName": JSON(app.localizedName), "windowTitle": nil]
    if Perms.accessibility {
      o["windowTitle"] = JSON(AX.focusedWindowTitle(pid: app.processIdentifier))
      if let id, AX.browsers.contains(id.lowercased()), let url = AX.browserURL(pid: app.processIdentifier) {
        o["browserUrl"] = .string(url)
      }
    }
    if blocklist.isBlocked(id) { o["blocked"] = true }
    return .object(o)
  }

  private func appsList() -> JSON {
    let front = frontApp?.processIdentifier
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    return ["apps": .array(apps.map { a in
      var o: [String: JSON] = [
        "bundleId": JSON(a.bundleIdentifier), "appName": JSON(a.localizedName), "pid": JSON(Int(a.processIdentifier)),
        "active": .bool(a.processIdentifier == front), "hidden": .bool(a.isHidden),
      ]
      if blocklist.isBlocked(a.bundleIdentifier) { o["blocked"] = true }
      return .object(o)
    })]
  }

  private func appActivate(_ p: Params) throws -> JSON {
    let id = try p.string("bundleId")
    guard !id.isEmpty else { throw ProtoError(.badRequest, "bundleId is empty") }
    try refuseBlocked(id, what: id)
    guard !Env.dryRun else { throw ProtoError(.noPermission, "dry run") }
    try needUnlocked()
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first {
      app.unhide()
      _ = app.activate()
      return ["ok": true, "launched": false]
    }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else {
      throw ProtoError(.noElement, "no app with bundle id \(id)")
    }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in
      if let err { log("launch failed: \(err.localizedDescription)") }
    }
    return ["ok": true, "launched": true]
  }

  private func axTree(_ p: Params) throws -> JSON {
    let id = try p.optString("bundleId")
    let maxNodes = try p.int("maxNodes", default: 150, range: 1...1500)
    let app: NSRunningApplication?
    if let id { app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first }
    else { app = frontApp }
    try refuseBlocked(id ?? app?.bundleIdentifier, what: "the frontmost app")
    try needAccessibility()
    try needUnlocked()
    guard let app else { throw ProtoError(.noElement, "app is not running") }
    try refuseBlocked(app.bundleIdentifier, what: "the app")
    refs = [:] // older refs are stale now; numbers keep counting up
    let nodes = AX.snapshot(pid: app.processIdentifier, maxNodes: maxNodes)
    return [
      "bundleId": JSON(app.bundleIdentifier), "appName": JSON(app.localizedName),
      "windowTitle": JSON(AX.focusedWindowTitle(pid: app.processIdentifier)),
      "elements": .array(nodes.map(register)),
    ]
  }

  private func elementReq(_ p: Params) throws -> JSON {
    let ref = try p.string("ref")
    try needAccessibility()
    try needUnlocked()
    let n = try node(ref)
    try refuseBlocked(bundleId(n.pid), what: "the element's app")
    let fresh = AX.node(n.element, pid: n.pid)
    refs[ref] = fresh
    let app = NSRunningApplication(processIdentifier: n.pid)
    let window = AX.window(of: n.element, pid: n.pid)
    var o: [String: JSON] = [
      "bundleId": JSON(app?.bundleIdentifier), "appName": JSON(app?.localizedName),
      "windowTitle": JSON(window.flatMap { AX.string($0, kAXTitleAttribute) }),
      "element": fresh.json(ref: ref),
    ]
    if let b = AX.defaultButton(in: window) { o["defaultButton"] = register(AX.node(b, pid: n.pid)) }
    return .object(o)
  }

  private func elementAt(_ p: Params) throws -> JSON {
    guard let pt = try p.point() else { throw ProtoError(.badRequest, "x and y are required") }
    try needAccessibility()
    try needUnlocked()
    let at = CGPoint(x: pt.x, y: pt.y)
    try refuseBlocked(targetBundleId(at: at), what: "the app under the point")
    guard let pid = targetPid(at: at) else { throw ProtoError(.noElement, "nothing at that point") }
    guard let n = hit(at: at) else { return try targetJSON(nil, pid: pid) }
    return try targetJSON(n, pid: n.pid)
  }

  private func focusedReq() throws -> JSON {
    try needAccessibility()
    try needUnlocked()
    guard let front = frontApp else { throw ProtoError(.noElement, "no app is in front") }
    try refuseBlocked(front.bundleIdentifier, what: "the frontmost app")
    guard let el = AX.focusedElement(), let pid = AX.pid(el) else {
      return try targetJSON(nil, pid: front.processIdentifier)
    }
    return try targetJSON(AX.node(el, pid: pid), pid: pid)
  }

  private func click(_ p: Params) async throws -> JSON {
    let button = try Input.Button(rawValue: p.optString("button") ?? "left")
      .orThrow(ProtoError(.badRequest, "button must be left, right or middle"))
    let count = try p.int("count", default: 1, range: 1...3)
    let ref = try p.optString("ref")
    let expectRef = try p.optString("expectRef")
    let xy = try p.point()
    guard ref != nil || xy != nil else { throw ProtoError(.badRequest, "ref or x,y is required") }
    if ref != nil || expectRef != nil { try needAccessibility() }
    let pt: CGPoint, size: Double?, refNode: AXNode?
    if let ref {
      let r = try resolve(ref)
      (pt, size, refNode) = (r.point, r.size, r.node)
    } else {
      (pt, size, refNode) = (CGPoint(x: xy!.x, y: xy!.y), nil, nil)
    }
    // The element the press must land on: the ref itself, or expectRef.
    let expected = try expectRef.map { try node($0) } ?? refNode
    try pointerAllowed(pt, refPid: expected?.pid)
    try needInput()
    let check = {
      try self.pointerAllowed(pt, refPid: expected?.pid)
      if let expected {
        guard let h = self.hit(at: pt), AX.same(h.element, orInside: expected.element) else {
          throw ProtoError(.targetChanged, "something else is at that point now")
        }
      }
    }
    try await acting {
      try await input.click(at: pt, size: size, button: button, count: count, allowed: check)
    }
    return ["ok": true, "x": JSON(pt.x), "y": JSON(pt.y)]
  }

  private func type(_ p: Params) async throws -> JSON {
    let text = try p.string("text")
    guard text.count <= 5000 else { throw ProtoError(.badRequest, "text is longer than 5000 characters") }
    let ref = try p.optString("ref")
    try needAccessibility()
    let tgt = try ref.map { try resolve($0) }
    if let tgt {
      if tgt.node.secure { throw ProtoError(.secureField, "that is a password field") }
      guard AX.textRolesForTyping.contains(tgt.node.role) || tgt.node.subrole == "AXSearchField" else {
        throw ProtoError(.badRequest, "that element is not a text field")
      }
      try pointerAllowed(tgt.point, refPid: tgt.node.pid)
    }
    // With a ref the click brings its app forward first; the keys are checked after it.
    else { try keysAllowed(secureCheck: true) }
    try needInput()
    try await acting {
      let focus: AXUIElement
      if let tgt {
        let el = tgt.node.element
        try await input.click(at: tgt.point, size: tgt.size, button: .left, count: 1) {
          try self.pointerAllowed(tgt.point, refPid: tgt.node.pid)
          guard let h = self.hit(at: tgt.point), AX.same(h.element, orInside: el) else {
            throw ProtoError(.targetChanged, "something else is at that field's place now")
          }
        }
        try await Task.sleep(nanoseconds: 150_000_000) // let focus land
        guard let now = AX.focusedElement(), AX.same(now, orInside: el) else {
          throw ProtoError(.targetChanged, "the field did not take the focus")
        }
        focus = now
      } else {
        guard let now = AX.focusedElement() else { throw ProtoError(.noElement, "nothing has the keyboard focus") }
        focus = now
      }
      try keysAllowed(secureCheck: true, focus: focus)
      try await input.type(text) { try self.keysAllowed(secureCheck: true, focus: focus) }
    }
    return ["ok": true, "typed": JSON(text.count)]
  }

  private func key(_ p: Params) async throws -> JSON {
    let combo = try parseKeyCombo(try p.string("combo"))
    // In a password field only Return, Tab and Escape, unmodified.
    let safeInSecure = combo.modifiers.isEmpty && [KeyCode.returnKey, KeyCode.tab, KeyCode.escape].contains(combo.keyCode)
    try keysAllowed(secureCheck: !safeInSecure)
    try needInput()
    try await acting { try await input.key(combo) { try self.keysAllowed(secureCheck: !safeInSecure) } }
    return ["ok": true]
  }

  private func scroll(_ p: Params) async throws -> JSON {
    guard let pt = try p.point() else { throw ProtoError(.badRequest, "x and y are required") }
    let dx = try p.optNumber("dx") ?? 0, dy = try p.optNumber("dy") ?? 0
    guard abs(dx) <= 20_000, abs(dy) <= 20_000 else { throw ProtoError(.badRequest, "dx and dy must be within 20000") }
    let at = CGPoint(x: pt.x, y: pt.y)
    try pointerAllowed(at, refPid: nil)
    try needInput()
    try await acting {
      try await input.scroll(at: at, dx: Int(dx.rounded()), dy: Int(dy.rounded())) { try self.pointerAllowed(at, refPid: nil) }
    }
    return ["ok": true]
  }

  private func screenshot(_ p: Params) async throws -> JSON {
    let maxWidth = try p.int("maxWidth", default: 1280, range: 256...3840)
    var exclude: [String] = []
    if p.has("exclude") {
      guard let a = p.raw["exclude"]?.array, a.count <= 500, a.allSatisfy({ $0.string != nil }) else {
        throw ProtoError(.badRequest, "exclude must be a list of bundle ids")
      }
      exclude = a.compactMap(\.string).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    guard Perms.screen else { throw ProtoError(.noPermission, "Screen Recording is not granted") }
    // Secure field redaction reads the AX tree; without it, no screenshot.
    try needAccessibility()
    try needUnlocked()
    let shot = try await Screenshot.capture(maxWidth: maxWidth, blocklist: blocklist, exclude: exclude)
    return ["png": .string(shot.png.base64EncodedString()), "width": JSON(shot.width), "height": JSON(shot.height),
            "scale": JSON((shot.scale * 1000).rounded() / 1000), "excluded": .array(shot.excluded.map { .string($0) }), "redacted": true]
  }

  // ring: true/false for the edge ring, or a frame {x, y, w, h} to
  // highlight (the edge ring is left as it is).
  private func overlayReq(_ p: Params) throws -> JSON {
    let raw = try p.optString("state") ?? "idle"
    guard let state = Overlay.State(rawValue: raw) else {
      throw ProtoError(.badRequest, "state must be idle, listening, thinking or speaking")
    }
    let subtitle = try p.optString("subtitle")
    let cursor = try p.point("cursor").map { CGPoint(x: $0.x, y: $0.y) }
    var ring: Bool?
    var highlight: CGRect?
    if let o = p.raw["ring"]?.object {
      let f = Params(o)
      let (x, y, w, h) = (try f.number("x"), try f.number("y"), try f.number("w"), try f.number("h"))
      guard w > 0, h > 0 else { throw ProtoError(.badRequest, "ring frame must have a positive size") }
      highlight = CGRect(x: x, y: y, width: w, height: h)
    } else {
      ring = try p.optBool("ring")
    }
    if !Env.dryRun {
      overlay.apply(state: state, subtitle: subtitle, cursor: cursor, ring: ring)
      if let highlight { overlay.highlight(highlight) }
    }
    return ["ok": true]
  }
}

extension Optional {
  func orThrow(_ e: @autoclosure () -> Error) throws -> Wrapped {
    guard let v = self else { throw e() }
    return v
  }
}
