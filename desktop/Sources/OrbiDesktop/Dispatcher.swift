import AppKit
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
// key. Typing also refuses a focused secure field or secure keyboard entry.
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
    case .element_at: return try elementAt(p)
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

  // The app a click or scroll at p would reach: the owner of the frontmost
  // window under the point (not ours), or the frontmost app for the menu bar
  // and for points with no window.
  func targetBundleId(at p: CGPoint) -> String? {
    let me = getpid()
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list {
      guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me,
            (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let b = w[kCGWindowBounds as String] as? NSDictionary,
            let r = CGRect(dictionaryRepresentation: b), r.contains(p) else { continue }
      if let id = bundleId(pid) { return id }
      break // the Window Server's menu bar: the menus are the frontmost app's
    }
    return frontApp?.bundleIdentifier
  }

  // Before any key or character: nothing goes to a blocked app or a
  // password field.
  private func keysAllowed(secureCheck: Bool) throws {
    try needUnlocked()
    guard let front = frontApp else { throw ProtoError(.blockedApp, "no frontmost app") }
    try refuseBlocked(front.bundleIdentifier, what: "the frontmost app")
    if secureCheck, AX.secureInputActive() {
      throw ProtoError(.noPermission, "the focused field is a password field")
    }
  }

  private func pointerAllowed(_ p: CGPoint, refPid: pid_t?) throws {
    try needUnlocked()
    if let refPid { try refuseBlocked(bundleId(refPid), what: "the element's app") }
    try refuseBlocked(targetBundleId(at: p), what: "the app under the pointer")
  }

  private func acting<T>(_ body: () async throws -> T) async rethrows -> T {
    overlay.beginAction()
    defer { overlay.endAction() }
    return try await body()
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
    let maxNodes = try p.int("maxNodes", default: 150, range: 1...500)
    let app: NSRunningApplication?
    if let id { app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first }
    else { app = frontApp }
    try refuseBlocked(id ?? app?.bundleIdentifier, what: "the frontmost app")
    try needAccessibility()
    try needUnlocked()
    guard let app else { throw ProtoError(.noElement, "app is not running") }
    try refuseBlocked(app.bundleIdentifier, what: "the app")
    refs = [:]
    nextRef = 1
    let nodes = AX.snapshot(pid: app.processIdentifier, maxNodes: maxNodes)
    let elements: [JSON] = nodes.map { n in
      let ref = "e\(nextRef)"
      nextRef += 1
      refs[ref] = n
      return n.json(ref: ref)
    }
    return ["bundleId": JSON(app.bundleIdentifier), "elements": .array(elements)]
  }

  private func elementAt(_ p: Params) throws -> JSON {
    guard let pt = try p.point() else { throw ProtoError(.badRequest, "x and y are required") }
    try needAccessibility()
    try needUnlocked()
    try refuseBlocked(targetBundleId(at: CGPoint(x: pt.x, y: pt.y)), what: "the app under the point")
    guard let n = AX.hitTest(x: pt.x, y: pt.y) else { throw ProtoError(.noElement, "nothing at that point") }
    try refuseBlocked(bundleId(n.pid), what: "the element's app")
    let ref = "e\(nextRef)"
    nextRef += 1
    refs[ref] = n
    return n.json(ref: ref)
  }

  // A ref's live center and size, read again now (the element may have moved).
  private func resolve(_ ref: String) throws -> (CGPoint, Double, pid_t) {
    guard let n = refs[ref] else { throw ProtoError(.noElement, "unknown or stale ref \(ref)") }
    guard let f = AX.frame(n.element) ?? n.frame, f.width > 0, f.height > 0 else {
      throw ProtoError(.noElement, "\(ref) is no longer on screen")
    }
    return (CGPoint(x: f.midX, y: f.midY), Double(min(f.width, f.height)), n.pid)
  }

  private func target(_ p: Params) throws -> (CGPoint, Double?, pid_t?) {
    if let ref = try p.optString("ref") {
      let (c, size, pid) = try resolve(ref)
      return (c, size, pid)
    }
    guard let pt = try p.point() else { throw ProtoError(.badRequest, "ref or x,y is required") }
    return (CGPoint(x: pt.x, y: pt.y), nil, nil)
  }

  private func needInput() throws {
    guard Perms.input else { throw ProtoError(.noPermission, "Accessibility is not granted, so Orbi cannot use the mouse or keyboard") }
  }

  private func click(_ p: Params) async throws -> JSON {
    let button = try Input.Button(rawValue: p.optString("button") ?? "left")
      .orThrow(ProtoError(.badRequest, "button must be left, right or middle"))
    let count = try p.int("count", default: 1, range: 1...3)
    if p.has("ref") { try needAccessibility() }
    let (pt, size, pid) = try target(p)
    try pointerAllowed(pt, refPid: pid)
    try needInput()
    try await acting {
      try await input.click(at: pt, size: size, button: button, count: count) {
        try self.pointerAllowed(pt, refPid: pid)
      }
    }
    return ["ok": true, "x": JSON(pt.x), "y": JSON(pt.y)]
  }

  private func type(_ p: Params) async throws -> JSON {
    let text = try p.string("text")
    guard text.count <= 5000 else { throw ProtoError(.badRequest, "text is longer than 5000 characters") }
    let ref = try p.optString("ref")
    if ref != nil { try needAccessibility() }
    let tgt = try ref.map { try resolve($0) }
    if let tgt { try pointerAllowed(tgt.0, refPid: tgt.2) }
    // With a ref the click brings its app forward first; the keys are checked after it.
    if tgt == nil { try keysAllowed(secureCheck: true) }
    try needInput()
    try await acting {
      if let (pt, size, pid) = tgt {
        try await input.click(at: pt, size: size, button: .left, count: 1) { try self.pointerAllowed(pt, refPid: pid) }
        try await Task.sleep(nanoseconds: 120_000_000) // let focus land
      }
      try keysAllowed(secureCheck: true)
      var n = 0
      try await input.type(text) {
        n += 1
        // The front app every key; the secure field check every few.
        try self.keysAllowed(secureCheck: n % 8 == 1)
      }
    }
    return ["ok": true, "typed": JSON(text.count)]
  }

  private func key(_ p: Params) async throws -> JSON {
    let combo = try parseKeyCombo(try p.string("combo"))
    try keysAllowed(secureCheck: false)
    try needInput()
    try await acting { try await input.key(combo) }
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
    guard Perms.screen else { throw ProtoError(.noPermission, "Screen Recording is not granted") }
    // Secure field redaction reads the AX tree; without it, no screenshot.
    try needAccessibility()
    try needUnlocked()
    let shot = try await Screenshot.capture(maxWidth: maxWidth, blocklist: blocklist)
    return ["png": .string(shot.png.base64EncodedString()), "width": JSON(shot.width), "height": JSON(shot.height),
            "scale": JSON((shot.scale * 1000).rounded() / 1000)]
  }

  private func overlayReq(_ p: Params) throws -> JSON {
    let raw = try p.optString("state") ?? "idle"
    guard let state = Overlay.State(rawValue: raw) else {
      throw ProtoError(.badRequest, "state must be idle, listening, thinking or speaking")
    }
    let subtitle = try p.optString("subtitle")
    let cursor = try p.point("cursor").map { CGPoint(x: $0.x, y: $0.y) }
    let ring = try p.optBool("ring")
    if !Env.dryRun { overlay.apply(state: state, subtitle: subtitle, cursor: cursor, ring: ring) }
    return ["ok": true]
  }
}

extension Optional {
  func orThrow(_ e: @autoclosure () -> Error) throws -> Wrapped {
    guard let v = self else { throw e() }
    return v
  }
}
