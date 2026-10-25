import AppKit
import OrbiDesktopCore

// The menu-bar app: no Dock icon, a status dot (grey connecting, green
// connected, red while the mic is open), a Permissions window, the talk key
// hint, the Watchable Pace and Show Cursor settings, and Quit. Wires the connection, the dispatcher, the talk key, the mic
// and TTS playback together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let overlay = Overlay()
  private lazy var input = Input(overlay: overlay)
  private lazy var dispatcher = Dispatcher(overlay: overlay, input: input)
  private let connection = Connection(path: Env.socketPath)
  private let hotkey = Hotkey()
  private let mic = Mic()
  private let player = Player()
  private var statusItem: NSStatusItem?
  private var statusLine: NSMenuItem?
  private var permissionsWindow: PermissionsWindow?
  private var lastPerms = Perms.current
  private var permTimer: Timer?
  private var connected = false
  private var latchedHere = false

  func applicationDidFinishLaunching(_ note: Notification) {
    if let scenes = Env.snapshotScenes {
      Task { @MainActor in exit(await OverlaySnapshots.run(scenes: scenes, out: Env.snapshotOut)) }
      return
    }
    if !Env.dryRun {
      buildMenu()
      overlay.setShowCursor(Settings.showCursor)
      overlay.start()
      hotkey.install()
    }
    hotkey.onActions = { [weak self] in self?.ptt($0) }
    mic.onChunk = { [weak self] in self?.connection.send(binary: $0) }
    dispatcher.send = { [weak self] in self?.connection.send(text: $0) }

    connection.onStatus = { [weak self] s in
      guard let self else { return }
      self.connected = s == .connected
      self.refreshStatus()
      if !Env.dryRun { self.overlay.link(up: self.connected) } // the closed and back cues
    }
    connection.onDisconnect = { [weak self] in
      guard let self else { return }
      self.dispatcher.reset()
      self.player.stop(local: false)
      self.latchedHere = false
      self.overlay.reset()
    }
    connection.onBinary = { [weak self] in
      guard let self, !Env.dryRun, let t = self.player.play($0) else { return }
      self.overlay.speechAudio(samples: t.samples, inSeconds: t.inSeconds)
    }
    connection.onMessage = { [weak self] in self?.inbound($0) }
    connection.start()

    // Permissions only change in System Settings; notice it, re-arm the
    // talk key, and say hello again so the server sees the new state.
    permTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.checkPermissions() }
    }
    if !Env.dryRun, !(lastPerms.accessibility && lastPerms.screen && lastPerms.mic) { showPermissions() }
  }

  private func inbound(_ m: Inbound) {
    switch m {
    case .welcome(_, let blocked), .config(let blocked):
      if let blocked { dispatcher.blocklist.setServerEntries(blocked) }
    case .request(let id, let method, let params):
      dispatcher.handle(id: id, method: method, params: params)
    case .badRequest(let id, let message):
      connection.send(text: Outbound.error(id: id, ProtoError(.badRequest, message)))
    case .challenge:
      break // handled by the connection before welcome
    case .audioStop:
      player.stop(local: false)
      overlay.stopSpeech()
    case .unknown(let t):
      log("ignored message type \(t)")
    }
  }

  private func ptt(_ actions: [PushToTalk.Action]) {
    for a in actions {
      switch a {
      case .micOpen: mic.open()
      case .micStream: mic.stream()
      case .micClose: mic.close()
      case .stopPlayback:
        player.stop(local: true)
        overlay.stopSpeech()
      case .send(let e):
        guard connection.isConnected else { break }
        connection.send(text: Outbound.event(e))
        earcon(e)
      }
    }
    refreshStatus()
  }

  // The extension's talk key cues (lib/voice/controller.js): listen once a
  // hold is confirmed or a latch starts, after cut when that barged in on
  // speech or a reply; sent when it is let go or the latch ends.
  private func earcon(_ e: PTTEvent) {
    var starting = e == .pttDown
    if e == .latchToggle {
      latchedHere.toggle()
      starting = latchedHere
    }
    if starting {
      let cut = overlay.state == .speaking || overlay.state == .thinking
      if cut { overlay.cue("cut") }
      overlay.cue("listen", afterCut: cut)
    } else {
      overlay.cue("sent")
    }
  }

  private func checkPermissions() {
    let now = Perms.current
    guard now != lastPerms else { return }
    if now.accessibility && !lastPerms.accessibility && !Env.dryRun { hotkey.install() }
    lastPerms = now
    permissionsWindow?.refresh()
    connection.restart()
  }

  // ------------------------------------------------------------ menu

  private func buildMenu() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    let status = NSMenuItem(title: "Connecting to Orbi", action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Permissions…", action: #selector(showPermissions), keyEquivalent: "").target = self
    let hint = NSMenuItem(title: "Hold Right Option to talk. Double-tap to keep listening.", action: nil, keyEquivalent: "")
    hint.isEnabled = false
    menu.addItem(hint)
    menu.addItem(.separator())
    let pace = menu.addItem(withTitle: "Watchable Pace", action: #selector(togglePace(_:)), keyEquivalent: "")
    pace.target = self
    pace.state = Settings.watchablePace ? .on : .off
    pace.toolTip = "Clicks and scrolls go at a pace you can follow. Off: they happen at once."
    let cursor = menu.addItem(withTitle: "Show Cursor", action: #selector(toggleCursor(_:)), keyEquivalent: "")
    cursor.target = self
    cursor.state = Settings.showCursor ? .on : .off
    cursor.toolTip = "Orbi's own cursor, showing where it points and clicks."
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Orbi Desktop", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
    statusItem = item
    statusLine = status
    refreshStatus()
  }

  private func refreshStatus() {
    guard let button = statusItem?.button else { return }
    let color: NSColor
    if mic.isOpen { color = NSColor(hex: 0xff3b30); statusLine?.title = "Listening" }
    else if connected { color = NSColor(hex: 0x34c759); statusLine?.title = "Connected to Orbi" }
    else { color = NSColor(hex: 0x8e8e93); statusLine?.title = "Connecting to Orbi" }
    button.image = Self.dot(color)
    button.setAccessibilityLabel("Orbi Desktop, \(statusLine?.title ?? "")")
  }

  private static func dot(_ color: NSColor) -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
      let ring = NSBezierPath(ovalIn: r.insetBy(dx: 3, dy: 3))
      ring.lineWidth = 1.5
      NSColor.labelColor.withAlphaComponent(0.85).setStroke()
      ring.stroke()
      color.setFill()
      NSBezierPath(ovalIn: r.insetBy(dx: 6, dy: 6)).fill()
      return true
    }
    img.isTemplate = false
    return img
  }

  @objc private func togglePace(_ item: NSMenuItem) {
    Settings.watchablePace.toggle()
    item.state = Settings.watchablePace ? .on : .off
  }

  @objc private func toggleCursor(_ item: NSMenuItem) {
    Settings.showCursor.toggle()
    item.state = Settings.showCursor ? .on : .off
    overlay.setShowCursor(Settings.showCursor)
  }

  @objc private func showPermissions() {
    if permissionsWindow == nil { permissionsWindow = PermissionsWindow() }
    permissionsWindow?.show()
  }

  func applicationWillTerminate(_ note: Notification) {
    hotkey.remove()
    mic.close()
  }
}

// One row per permission: what it is for, whether it is on, and a button
// that opens its pane in System Settings. Nothing here changes a setting.
@MainActor
final class PermissionsWindow: NSObject, NSWindowDelegate {
  private let window: NSWindow
  private var rows: [(Perms.Pane, NSTextField)] = []

  private static let items: [(Perms.Pane, String, String)] = [
    (.accessibility, "Accessibility", "Read what is on screen and use the mouse and keyboard. Also needed for the talk key."),
    (.screen, "Screen Recording", "Take screenshots of the main display, with passwords and card numbers blacked out."),
    (.mic, "Microphone", "Hear you while you hold Right Option."),
  ]

  override init() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 260), styleMask: [.titled, .closable],
                      backing: .buffered, defer: false)
    super.init()
    window.title = "Orbi Desktop Permissions"
    window.isReleasedWhenClosed = false
    window.delegate = self
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 14
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    let intro = NSTextField(wrappingLabelWithString: "Orbi Desktop needs these to work. You turn each one on in System Settings; Orbi never changes them.")
    intro.preferredMaxLayoutWidth = 480
    stack.addArrangedSubview(intro)
    for (pane, name, why) in Self.items {
      let title = NSTextField(labelWithString: name)
      title.font = .boldSystemFont(ofSize: 13)
      let state = NSTextField(labelWithString: "")
      let detail = NSTextField(wrappingLabelWithString: why)
      detail.textColor = .secondaryLabelColor
      detail.preferredMaxLayoutWidth = 330
      let text = NSStackView(views: [NSStackView(views: [title, state]), detail])
      text.orientation = .vertical
      text.alignment = .leading
      text.spacing = 2
      let button = NSButton(title: "Open Settings", target: self, action: #selector(open(_:)))
      button.tag = Self.items.firstIndex { $0.0 == pane } ?? 0
      let row = NSStackView(views: [text, button])
      row.orientation = .horizontal
      row.alignment = .centerY
      row.distribution = .fill
      row.spacing = 16
      stack.addArrangedSubview(row)
      rows.append((pane, state))
    }
    window.contentView = stack
    refresh()
  }

  func show() {
    refresh()
    window.center()
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  func refresh() {
    let p = Perms.current
    for (pane, label) in rows {
      let on = switch pane { case .accessibility: p.accessibility; case .screen: p.screen; case .mic: p.mic }
      label.stringValue = on ? "On" : "Off"
      label.textColor = on ? .systemGreen : .systemOrange
    }
  }

  @objc private func open(_ sender: NSButton) {
    let pane = Self.items[sender.tag].0
    Perms.prompt(pane) // the system prompt adds Orbi Desktop to the list
    Perms.open(pane)
  }
}
