import AppKit
import OrbiDesktopCore
import WebKit

// The overlay: one transparent, click-through, borderless window over the
// main display, on every Space and above full-screen apps. It holds a web
// view that runs the extension's own overlay scripts, unchanged
// (desktop/Resources/overlay: the card with the orb face, its lip-sync and
// karaoke words, the R6b frame ring, the agent cursor and the earcons), so
// the desktop looks and moves exactly like Chrome. bridge.js there turns
// the calls below into the runtime messages those scripts already handle.
//
// The window ignores the mouse and the web view hit-tests to nothing, so it
// never takes a click, a key or the focus. CSS pixels are points, and the
// window's top left is the main display's, so AX/Quartz points are used as
// they are.
//
// The card's own backdrop blur only sees the empty page, so a native blur
// sits behind it, placed from the card's box (sent by bridge.js).
//
// The frame ring is on while a turn is in progress (any state but idle),
// while the helper is acting, and while the server asks (ring: true), like
// the extension's background/frame.js. It goes around the window Orbi acts
// in (the app of the last action, else the frontmost app's front window),
// followed while it is on. At idle the cursor rests where it is.
extension NSColor {
  convenience init(hex: Int, alpha: CGFloat = 1) {
    self.init(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
              blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
  }
}

enum OverlayAssets {
  // The overlay's files, by the path the page asks for, and where each is
  // in the repo. scripts/bundle.sh copies them to Resources/overlay.
  static let files: [String: String] = [
    "index.html": "desktop/Resources/overlay/index.html",
    "shim.js": "desktop/Resources/overlay/shim.js",
    "bridge.js": "desktop/Resources/overlay/bridge.js",
    "ext/orb-face.js": "extension/content/orb-face.js",
    "ext/subtitles.js": "extension/content/subtitles.js",
    "ext/frame.js": "extension/content/frame.js",
    "ext/cursor.js": "extension/content/cursor.js",
    "ext/karaoke.js": "extension/lib/voice/karaoke.js",
    "ext/chime.js": "extension/lib/voice/chime.js",
  ]
  static let scheme = "orbi-overlay"
  static let start = URL(string: "\(scheme)://app/index.html")!

  // The bundled copy, or for a plain swift build the repo's own files.
  static func url(_ path: String) -> URL? {
    guard let repoPath = files[path] else { return nil }
    if let res = Bundle.main.resourceURL?.appendingPathComponent("overlay/\(path)"),
       FileManager.default.fileExists(atPath: res.path) { return res }
    var repo = URL(fileURLWithPath: #filePath)
    for _ in 0..<4 { repo.deleteLastPathComponent() } // Sources/OrbiDesktop/Overlay.swift
    let file = repo.appendingPathComponent(repoPath)
    return FileManager.default.fileExists(atPath: file.path) ? file : nil
  }
}

// Serves only the files above, read-only, from orbi-overlay://app/.
private final class AssetHandler: NSObject, WKURLSchemeHandler {
  func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
    guard let url = task.request.url, url.host == "app",
          let file = OverlayAssets.url(String(url.path.dropFirst())),
          let data = try? Data(contentsOf: file) else {
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    let mime = file.pathExtension == "html" ? "text/html" : "text/javascript"
    let res = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                              headerFields: ["Content-Type": "\(mime); charset=utf-8", "Cache-Control": "no-store"])!
    task.didReceive(res)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

private final class ClickThroughWebView: WKWebView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override var acceptsFirstResponder: Bool { false }
}

private final class ClickThroughBlur: NSVisualEffectView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// Script messages without a retain cycle through the content controller.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var overlay: Overlay?
  init(_ o: Overlay) { overlay = o }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    let (name, body) = (m.name, m.body)
    MainActor.assumeIsolated { overlay?.message(name, body) }
  }
}

@MainActor
final class Overlay: NSObject, WKNavigationDelegate {
  typealias State = OverlayUpdate.State

  private(set) var state = State.idle
  private var window: NSWindow?
  private var web: WKWebView?
  private var blur: NSVisualEffectView?
  private var ready = false
  private var pending: [String] = []
  private var latched = false
  private var serverRing = false
  private var acting = 0
  private var frameSent: Bool?
  private var target: (rect: CGRect, at: Date)?
  private var drawn: CGPoint?
  private var glide: Task<Void, Never>?
  private var rng = Rng()
  private var screenObserver: NSObjectProtocol?
  private var showCursor = true
  // The app whose window gets the frame, and the box last sent.
  private var actingPid: pid_t?
  private var frameRect: CGRect?
  private var frameRectSent = false
  private var follow: Timer?
  // Off for the snapshot harness, which places the frame itself.
  var tracksWindows = true

  var cursorPoint: CGPoint? { drawn }
  var isReady: Bool { ready }

  // The live overlay over the main display.
  func start() {
    guard window == nil, let screen = NSScreen.screens.first else { return }
    let w = build(frame: screen.frame)
    w.level = .screenSaver
    w.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    w.orderFrontRegardless()
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, let w = self.window, let s = NSScreen.screens.first else { return }
        w.setFrame(s.frame, display: true)
      }
    }
  }

  // A window at frame holding the page. The snapshot harness uses it off
  // screen, where WebKit would pause animation frames for a window it
  // thinks is hidden, so there it is told the window is never occluded.
  @discardableResult
  func build(frame: NSRect, offscreen: Bool = false) -> NSWindow {
    let w = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
    w.ignoresMouseEvents = true
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = false
    w.isReleasedWhenClosed = false
    w.animationBehavior = .none
    // Not an accessibility element, so hit tests look through it.
    w.setAccessibilityElement(false)
    let content = NSView(frame: NSRect(origin: .zero, size: frame.size))

    let blur = ClickThroughBlur(frame: .zero)
    blur.material = .popover
    blur.blendingMode = .behindWindow
    blur.state = .active
    blur.wantsLayer = true
    blur.layer?.cornerRadius = 22
    blur.layer?.masksToBounds = true
    blur.alphaValue = 0
    content.addSubview(blur)

    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(AssetHandler(), forURLScheme: OverlayAssets.scheme)
    config.mediaTypesRequiringUserActionForPlayback = [] // the earcons
    config.suppressesIncrementalRendering = true
    let handler = WeakHandler(self)
    config.userContentController.add(handler, name: "orbiReady")
    config.userContentController.add(handler, name: "orbiCard")
    let web = ClickThroughWebView(frame: content.bounds, configuration: config)
    web.autoresizingMask = [.width, .height]
    web.setValue(false, forKey: "drawsBackground")
    web.underPageBackgroundColor = .clear
    web.allowsMagnification = false
    web.allowsBackForwardNavigationGestures = false
    web.navigationDelegate = self
    // WebKit's private setter, only when this WebKit has it (KVC on a
    // missing key would raise).
    let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if offscreen, web.responds(to: occlusion) { web.perform(occlusion, with: false as NSNumber) }
    content.addSubview(web)
    w.contentView = content
    web.load(URLRequest(url: OverlayAssets.start))
    (self.window, self.web, self.blur) = (w, web, blur)
    return w
  }

  // ------------------------------------------------------------ page

  // Only the overlay's own page ever loads.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
    action.request.url?.scheme == OverlayAssets.scheme ? .allow : .cancel
  }

  // The page died (WebContent crashed): load it again and replay the state.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    ready = false
    frameSent = nil
    webView.load(URLRequest(url: OverlayAssets.start))
  }

  fileprivate func message(_ name: String, _ body: Any) {
    switch name {
    case "orbiReady":
      ready = true
      let queued = pending
      pending = []
      var u = OverlayUpdate()
      u.state = state
      u.latched = latched
      call("settings", ["showCursor": .bool(showCursor)])
      frameRectSent = false
      send(u)
      for js in queued { web?.evaluateJavaScript(js) }
    case "orbiCard":
      guard let o = body as? [String: Any], let blur, let host = blur.superview else { return }
      let n = { (k: String) in (o[k] as? NSNumber)?.doubleValue ?? 0 }
      let (x, y, w, h) = (n("x"), n("y"), n("w"), n("h"))
      guard [x, y, w, h].allSatisfy(\.isFinite), w >= 0, h >= 0 else { return }
      blur.frame = NSRect(x: x, y: host.bounds.height - y - h, width: w, height: h)
      blur.alphaValue = CGFloat(min(1, max(0, n("opacity"))))
    default:
      break
    }
  }

  private func run(_ js: String) {
    guard let web else { return }
    if ready { web.evaluateJavaScript(js) }
    else if pending.count < 500 { pending.append(js) }
  }

  private func call(_ fn: String, _ arg: JSON) { run("orbi.\(fn)(\(arg.encoded()))") }

  private var frameWanted: Bool { serverRing || acting > 0 || state != .idle }

  private func send(_ u: OverlayUpdate) {
    let on = frameWanted
    let frame: Bool? = on == frameSent ? nil : on
    frameSent = on
    var o = u.webJSON(frame: frame).object ?? [:]
    if on, tracksWindows { trackWindow() }
    if !frameRectSent { o["frameRect"] = rectJSON(frameRect); frameRectSent = true }
    call("apply", .object(o))
    following(on && tracksWindows)
  }

  private func rectJSON(_ r: CGRect?) -> JSON {
    guard let r else { return .null }
    return ["x": JSON(Double(r.minX)), "y": JSON(Double(r.minY)), "w": JSON(Double(r.width)), "h": JSON(Double(r.height))]
  }

  // ------------------------------------------------------------ frame

  // The window the frame goes around, or nil for the whole screen.
  func setFrameRect(_ r: CGRect?) {
    guard r != frameRect else { return }
    frameRect = r
    frameRectSent = true
    call("apply", ["frameRect": rectJSON(r)])
  }

  private func trackWindow() {
    let pid = actingPid ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
    setFrameRect(pid.flatMap(Self.frontWindow))
  }

  // While the frame is on, it follows the window as it moves or resizes.
  private func following(_ on: Bool) {
    if !on { follow?.invalidate(); follow = nil; return }
    guard follow == nil else { return }
    follow = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.trackWindow() }
    }
  }

  // pid's frontmost normal window on screen, in the overlay's points (the
  // main display's top left), or nil when it has none or it fills the
  // screen (then the frame goes round the screen, as before).
  static func frontWindow(of pid: pid_t) -> CGRect? {
    guard pid != getpid() else { return nil }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list {
      guard w[kCGWindowOwnerPID as String] as? pid_t == pid, w[kCGWindowLayer as String] as? Int == 0,
            (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let b = w[kCGWindowBounds as String] as? NSDictionary,
            let r = CGRect(dictionaryRepresentation: b), r.width >= 80, r.height >= 80 else { continue }
      if let screen = NSScreen.screens.first?.frame, r.insetBy(dx: -1, dy: -1).contains(CGRect(origin: .zero, size: screen.size)) { return nil }
      return r
    }
    return nil
  }

  // ------------------------------------------------------------ server

  func apply(_ u: OverlayUpdate) {
    let wasIdle = state == .idle
    if let s = u.state { state = s }
    if let l = u.latched { latched = l } else if u.state != nil { latched = false }
    if let r = u.ring { serverRing = r }
    if let t = u.target { target = (CGRect(x: t.x, y: t.y, width: t.w, height: t.h), Date()) }
    send(u)
    // The end of a turn: the cursor rests where it is (its action line goes).
    if state == .idle, !wasIdle {
      cursor(["phase": "hide"])
      if acting == 0 { actingPid = nil }
    }
    if let c = u.cursor { glide(to: CGPoint(x: c.x, y: c.y)) }
  }

  // pid: the app acted on, whose window gets the frame.
  func beginAction(pid: pid_t? = nil) {
    if let pid { actingPid = pid }
    acting += 1
    send(OverlayUpdate())
  }
  func endAction() { acting = max(0, acting - 1); send(OverlayUpdate()) }

  // The server went away.
  func reset() {
    glide?.cancel()
    state = .idle
    latched = false
    serverRing = false
    target = nil
    frameSent = false
    actingPid = nil
    following(false)
    run("orbi.reset()")
  }

  // ------------------------------------------------------------ voice

  // n samples of speech scheduled, first heard `inSeconds` from now.
  func speechAudio(samples n: Int, inSeconds: Double) {
    run("orbi.chunk(\(n), \(Int((inSeconds * 1000).rounded())))")
  }

  func stopSpeech() { run("orbi.stopSpeech()") }

  func cue(_ name: String, afterCut: Bool = false) {
    call("apply", ["cue": .string(name), "cueAfterCut": .bool(afterCut)])
  }

  func link(up: Bool) { call("apply", ["link": .bool(up)]) }

  // The menu's Show Cursor (content/cursor.js reads it as the extension's
  // showCursor setting).
  func setShowCursor(_ on: Bool) {
    showCursor = on
    call("settings", ["showCursor": .bool(on)])
  }

  // ------------------------------------------------------------ cursor

  // Pointer samples, as background/actor.js sends content/cursor.js: the
  // real pointer's path as Input posts it, so the drawn arrow is where the
  // events land.
  private func cursor(_ s: [String: JSON]) { call("cursor", .object(s)) }

  private func pt(_ p: CGPoint) -> [String: JSON] { ["x": JSON(Double(p.x)), "y": JSON(Double(p.y))] }

  func cursorMove(_ p: CGPoint, to: CGPoint, action: String) {
    drawn = p
    var s = pt(p)
    s["phase"] = "move"
    s["action"] = .string(action)
    s["to"] = .object(pt(to))
    cursor(s)
  }

  func cursorAt(_ p: CGPoint) {
    glide?.cancel()
    cursorMove(p, to: p, action: "hover")
  }

  // A press plays the ripple; inside the target the server named, also the
  // ring pulse and the spectrum highlight on it.
  func press(_ p: CGPoint) {
    drawn = p
    var s = pt(p)
    s["phase"] = "press"
    if let t = target, Date().timeIntervalSince(t.at) < 4, t.rect.insetBy(dx: -4, dy: -4).contains(p) {
      s["rect"] = ["x": JSON(Double(t.rect.minX)), "y": JSON(Double(t.rect.minY)),
                   "width": JSON(Double(t.rect.width)), "height": JSON(Double(t.rect.height))]
    }
    cursor(s)
  }

  func release(_ p: CGPoint) {
    var s = pt(p)
    s["phase"] = "release"
    cursor(s)
  }

  func wheel(_ p: CGPoint) {
    drawn = p
    var s = pt(p)
    s["phase"] = "wheel"
    s["action"] = "scroll"
    cursor(s)
  }

  func typing(_ text: String) {
    var s = drawn.map(pt) ?? [:]
    s["phase"] = "type"
    s["action"] = "type"
    // background/cursor.js CAPTION_CHARS
    s["text"] = .string(String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(60)))
    cursor(s)
  }

  func keyPressed() {
    var s = drawn.map(pt) ?? [:]
    s["phase"] = "key"
    s["action"] = "type"
    cursor(s)
  }

  // overlay {cursor}: only the drawn cursor, not the real pointer.

  // Runs body with the overlay window off screen, for a hit test that must
  // see what is under it. Put back at once, within the same run loop turn.
  func withoutWindow<T>(_ body: () -> T) -> T {
    guard let w = window, w.isVisible else { return body() }
    w.orderOut(nil)
    defer { w.orderFrontRegardless() }
    return body()
  }

  private func glide(to p: CGPoint) {
    glide?.cancel()
    guard let from = drawn, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
      cursorMove(p, to: p, action: "hover")
      return
    }
    let path = planPath(from: Point(x: from.x, y: from.y), to: Point(x: p.x, y: p.y), rng: &rng)
    glide = Task { @MainActor [weak self] in
      for step in path {
        if step.ms > 0 { try? await Task.sleep(nanoseconds: UInt64(step.ms * 1_000_000)) }
        if Task.isCancelled { return }
        self?.cursorMove(CGPoint(x: step.x, y: step.y), to: p, action: "hover")
      }
    }
  }

  // ------------------------------------------------------------ snapshots

  func script(_ js: String) { run(js) }

  func evaluate(_ js: String) async -> String {
    guard let web else { return "no page" }
    do { return String(describing: try await web.evaluateJavaScript(js) ?? "undefined") } catch { return "error: \(error)" }
  }

  func snapshot() async -> NSImage? {
    guard let web else { return nil }
    // Off screen there are no screen updates to wait for.
    let c = WKSnapshotConfiguration()
    c.afterScreenUpdates = false
    return try? await web.takeSnapshot(configuration: c)
  }
}
