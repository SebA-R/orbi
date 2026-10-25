import AppKit
import OrbiDesktopCore
import QuartzCore

// The overlay: one transparent, click-through, borderless window over the
// main display, on every Space and above full-screen apps. Styled like the
// extension's overlays:
//   - ring (content/frame.js, design R6b): a conic spectrum band around the
//     screen edge, 8 pt visible, inner corners rounded at 11 pt, opacity .45,
//     turning once every 6 s, fading over 300 ms. Shown while the server
//     asks (ring: true) and while the helper is executing an action.
//   - cursor (content/cursor.js, "Orb tag arrow"): a white arrow with a
//     spectrum outline that glides on a minimum-jerk path; a press plays a
//     ripple at the point.
//   - subtitle pill (content/subtitles.js): a frosted white card 28 pt above
//     the bottom, 22 pt corners, 21 pt medium ink text, the small orb at its
//     left.
// Reduced motion: the ring holds still and the cursor jumps.
let spectrum: [NSColor] = [0xff9f6b, 0xff5f8f, 0xb56cff, 0x5e8bff, 0x4fd1ff].map { NSColor(hex: $0) }

extension NSColor {
  convenience init(hex: Int, alpha: CGFloat = 1) {
    self.init(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
              blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
  }
}

private func reduceMotion() -> Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

private func noAnim(_ body: () -> Void) {
  CATransaction.begin()
  CATransaction.setDisableActions(true)
  body()
  CATransaction.commit()
}

// A view whose layer tree uses the top-left, y-down space of the screen, so
// AX/Quartz points can be used as they are.
private class FlippedLayerView: NSView {
  let root = CALayer()
  override init(frame: NSRect) {
    super.init(frame: frame)
    layer = root
    wantsLayer = true
    root.isGeometryFlipped = true
  }
  required init?(coder: NSCoder) { nil }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private final class RingView: FlippedLayerView {
  private let band = CALayer()
  private let gradient = CAGradientLayer()
  private let mask = CAShapeLayer()
  private(set) var on = false

  override init(frame: NSRect) {
    super.init(frame: frame)
    gradient.type = .conic
    gradient.startPoint = CGPoint(x: 0.5, y: 0.5)
    gradient.endPoint = CGPoint(x: 0.5, y: 0)
    gradient.colors = (spectrum + [spectrum[0]]).map(\.cgColor)
    band.addSublayer(gradient)
    mask.fillRule = .evenOdd
    band.mask = mask
    band.opacity = 0
    root.addSublayer(band)
    layout(for: frame.size)
  }
  required init?(coder: NSCoder) { nil }

  func layout(for size: CGSize) {
    noAnim {
      let b = CGRect(origin: .zero, size: size)
      band.frame = b
      mask.frame = b
      let path = CGMutablePath()
      path.addRect(b)
      path.addRoundedRect(in: b.insetBy(dx: 8, dy: 8), cornerWidth: 11, cornerHeight: 11)
      mask.path = path
      let d = hypot(size.width, size.height)
      gradient.bounds = CGRect(x: 0, y: 0, width: d, height: d)
      gradient.position = CGPoint(x: b.midX, y: b.midY)
    }
  }

  func set(_ visible: Bool) {
    guard visible != on else { return }
    on = visible
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = band.presentation()?.opacity ?? band.opacity
    fade.toValue = visible ? 0.45 : 0
    fade.duration = 0.3
    band.opacity = visible ? 0.45 : 0
    band.add(fade, forKey: "fade")
    if visible, !reduceMotion() {
      let turn = CABasicAnimation(keyPath: "transform.rotation.z")
      turn.fromValue = 0
      turn.toValue = Double.pi * 2
      turn.duration = 6
      turn.repeatCount = .infinity
      gradient.add(turn, forKey: "turn")
    } else if !visible {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
        if self?.on == false { self?.gradient.removeAnimation(forKey: "turn") }
      }
    }
  }
}

private final class CursorView: FlippedLayerView {
  private let arrow = CALayer()
  private var shown = false
  private(set) var at: CGPoint?

  override init(frame: NSRect) {
    super.init(frame: frame)
    // design 7's arrow, an 18 x 24 box with its tip at (2, 2)
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 2, y: 2))
    for (x, y) in [(2, 19.5), (6.6, 15.4), (9.6, 22), (12.6, 20.7), (9.7, 14.3), (15.8, 14.3)] {
      path.addLine(to: CGPoint(x: x, y: y))
    }
    path.closeSubpath()
    arrow.bounds = CGRect(x: 0, y: 0, width: 18, height: 24)
    arrow.anchorPoint = CGPoint(x: 2.0 / 18, y: 2.0 / 24)
    arrow.shadowColor = NSColor(hex: 0x141628).cgColor
    arrow.shadowOpacity = 0.28
    arrow.shadowRadius = 2
    arrow.shadowOffset = CGSize(width: 0, height: 2)
    let fill = CAShapeLayer()
    fill.path = path
    fill.fillColor = NSColor.white.cgColor
    let stroke = CAGradientLayer()
    stroke.frame = arrow.bounds
    stroke.startPoint = .zero
    stroke.endPoint = CGPoint(x: 1, y: 1)
    stroke.colors = spectrum.map(\.cgColor)
    let strokeMask = CAShapeLayer()
    strokeMask.path = path
    strokeMask.fillColor = nil
    strokeMask.strokeColor = NSColor.black.cgColor
    strokeMask.lineWidth = 1.7
    strokeMask.lineJoin = .round
    stroke.mask = strokeMask
    arrow.addSublayer(fill)
    arrow.addSublayer(stroke)
    arrow.opacity = 0
    root.addSublayer(arrow)
  }
  required init?(coder: NSCoder) { nil }

  func move(to p: CGPoint) {
    at = p
    noAnim {
      arrow.position = p
      if !shown { arrow.opacity = 1; shown = true }
    }
  }

  // The extension's .hl: a 2 pt spectrum outline 5 pt around the target,
  // held, then faded (1.4 s in all).
  func highlight(_ r: CGRect) {
    let box = r.insetBy(dx: -5, dy: -5)
    let g = CAGradientLayer()
    g.frame = box
    g.startPoint = CGPoint(x: 0, y: 0.5)
    g.endPoint = CGPoint(x: 1, y: 0.5)
    g.colors = spectrum.map(\.cgColor)
    let m = CAShapeLayer()
    m.path = CGPath(roundedRect: CGRect(origin: .zero, size: box.size).insetBy(dx: 1, dy: 1), cornerWidth: 14, cornerHeight: 14, transform: nil)
    m.fillColor = nil
    m.strokeColor = NSColor.black.cgColor
    m.lineWidth = 2
    g.mask = m
    g.opacity = 0
    root.insertSublayer(g, below: arrow)
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [1, 1, 0]
    fade.keyTimes = [0, 0.7, 1]
    fade.duration = 1.4
    g.add(fade, forKey: "hl")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.45) { g.removeFromSuperlayer() }
  }

  func press(at p: CGPoint) {
    move(to: p)
    let squeeze = CAKeyframeAnimation(keyPath: "transform.scale")
    squeeze.values = [1, 0.86, 1]
    squeeze.duration = 0.25
    arrow.add(squeeze, forKey: "press")
    guard !reduceMotion() else { return }
    let rip = CAShapeLayer()
    rip.bounds = CGRect(x: 0, y: 0, width: 46, height: 46)
    rip.path = CGPath(ellipseIn: rip.bounds.insetBy(dx: 1, dy: 1), transform: nil)
    rip.fillColor = NSColor(hex: 0xff5f8f, alpha: 0.14).cgColor
    rip.strokeColor = NSColor(hex: 0xb56cff, alpha: 0.9).cgColor
    rip.lineWidth = 2
    rip.opacity = 0
    noAnim { rip.position = p }
    root.insertSublayer(rip, below: arrow)
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.25
    grow.toValue = 1
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0.75
    fade.toValue = 0
    let g = CAAnimationGroup()
    g.animations = [grow, fade]
    g.duration = 0.52
    g.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
    rip.add(g, forKey: "rip")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { rip.removeFromSuperlayer() }
  }
}

// The small status orb: the extension's radial body (white to #c9b8ff to
// #5e8bff) with its F1 face, a spectrum swirl while thinking, and a pulse
// while listening or speaking.
private final class OrbView: NSView {
  private let body = CAGradientLayer()
  private let swirl = CAGradientLayer()
  private let face = CAShapeLayer()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    let b = CGRect(origin: .zero, size: frame.size)
    body.frame = b
    body.type = .radial
    body.colors = [NSColor.white, NSColor(hex: 0xc9b8ff), NSColor(hex: 0x5e8bff)].map(\.cgColor)
    body.locations = [0, 0.4, 0.75]
    body.startPoint = CGPoint(x: 0.35, y: 0.7)
    body.endPoint = CGPoint(x: 1.2, y: -0.1)
    body.cornerRadius = b.width / 2
    body.masksToBounds = true
    swirl.frame = b
    swirl.type = .conic
    swirl.startPoint = CGPoint(x: 0.5, y: 0.5)
    swirl.endPoint = CGPoint(x: 0.5, y: 1)
    swirl.colors = (spectrum + [spectrum[0]]).map(\.cgColor)
    swirl.opacity = 0
    body.addSublayer(swirl)
    // F1: dot eyes, soft smile (100 x 100 board scaled to the orb)
    let s = b.width / 100
    let p = CGMutablePath()
    p.addEllipse(in: CGRect(x: 31 * s, y: 50 * s, width: 10 * s, height: 12 * s))
    p.addEllipse(in: CGRect(x: 59 * s, y: 50 * s, width: 10 * s, height: 12 * s))
    face.path = p
    face.fillColor = NSColor(hex: 0x1d1d3a, alpha: 0.85).cgColor
    let smile = CAShapeLayer()
    let m = CGMutablePath()
    m.move(to: CGPoint(x: 38 * s, y: 36 * s))
    m.addQuadCurve(to: CGPoint(x: 62 * s, y: 36 * s), control: CGPoint(x: 50 * s, y: 26 * s))
    smile.path = m
    smile.fillColor = nil
    smile.strokeColor = NSColor(hex: 0x1d1d3a, alpha: 0.85).cgColor
    smile.lineWidth = max(1.2, 5 * s)
    smile.lineCap = .round
    body.addSublayer(face)
    body.addSublayer(smile)
    layer?.addSublayer(body)
    layer?.shadowColor = NSColor(hex: 0x5e8bff).cgColor
    layer?.shadowOpacity = 0.35
    layer?.shadowRadius = 5
  }
  required init?(coder: NSCoder) { nil }

  func set(_ state: Overlay.State) {
    body.removeAnimation(forKey: "pulse")
    swirl.removeAnimation(forKey: "spin")
    swirl.opacity = state == .thinking ? 0.55 : 0
    guard !reduceMotion() else { return }
    let pulse = CABasicAnimation(keyPath: "transform.scale")
    pulse.autoreverses = true
    pulse.repeatCount = .infinity
    pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    switch state {
    case .idle: pulse.toValue = 1.03; pulse.duration = 1.6
    case .listening: pulse.toValue = 1.12; pulse.duration = 0.45
    case .thinking: pulse.toValue = 1.04; pulse.duration = 0.8
    case .speaking: pulse.toValue = 1.08; pulse.duration = 0.22
    }
    pulse.fromValue = 1
    body.add(pulse, forKey: "pulse")
    if state == .thinking {
      let spin = CABasicAnimation(keyPath: "transform.rotation.z")
      spin.fromValue = 0
      spin.toValue = -Double.pi * 2
      spin.duration = 1.6
      spin.repeatCount = .infinity
      swirl.add(spin, forKey: "spin")
    }
  }
}

private final class PillView: NSView {
  let orb = OrbView(frame: NSRect(x: 0, y: 0, width: 26, height: 26))
  let text = NSTextField(wrappingLabelWithString: "")
  let hint = NSTextField(labelWithString: "")
  private let blur = NSVisualEffectView()
  private let tint = NSView()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    appearance = NSAppearance(named: .aqua)
    blur.material = .popover
    blur.blendingMode = .behindWindow
    blur.state = .active
    blur.wantsLayer = true
    blur.layer?.cornerRadius = 22
    blur.layer?.masksToBounds = true
    tint.wantsLayer = true
    tint.layer?.backgroundColor = NSColor(white: 1, alpha: 0.6).cgColor
    tint.layer?.cornerRadius = 22
    tint.layer?.borderWidth = 1
    tint.layer?.borderColor = NSColor(white: 0, alpha: 0.08).cgColor
    layer?.shadowColor = NSColor(hex: 0x1e223c).cgColor
    layer?.shadowOpacity = 0.14
    layer?.shadowRadius = 20
    layer?.shadowOffset = CGSize(width: 0, height: -10)

    text.font = .systemFont(ofSize: 21, weight: .medium)
    text.textColor = NSColor(hex: 0x1d1d1f)
    text.maximumNumberOfLines = 3
    text.lineBreakMode = .byTruncatingTail
    text.cell?.truncatesLastVisibleLine = true
    hint.font = .systemFont(ofSize: 13.5, weight: .regular)
    hint.textColor = NSColor(hex: 0x6e6e73)

    let lines = NSStackView(views: [hint, text])
    lines.orientation = .vertical
    lines.alignment = .leading
    lines.spacing = 3
    let row = NSStackView(views: [orb, lines])
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 12
    row.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 15, right: 20)
    for v in [blur, tint, row] as [NSView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      addSubview(v)
      NSLayoutConstraint.activate([
        v.leadingAnchor.constraint(equalTo: leadingAnchor), v.trailingAnchor.constraint(equalTo: trailingAnchor),
        v.topAnchor.constraint(equalTo: topAnchor), v.bottomAnchor.constraint(equalTo: bottomAnchor),
      ])
    }
    orb.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([orb.widthAnchor.constraint(equalToConstant: 26), orb.heightAnchor.constraint(equalToConstant: 26)])
    alphaValue = 0
  }
  required init?(coder: NSCoder) { nil }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func show(_ on: Bool) {
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = on ? 0.32 : 0.6
      animator().alphaValue = on ? 1 : 0
    }
  }
}

@MainActor
final class Overlay {
  enum State: String { case idle, listening, thinking, speaking }

  private var window: NSWindow?
  private var ring: RingView?
  private var cursor: CursorView?
  private var pill: PillView?
  private var serverRing = false
  private var acting = 0
  private var state = State.idle
  private var hideTimer: Timer?
  private var glide: Task<Void, Never>?
  private var rng = Rng()
  private var screenObserver: NSObjectProtocol?

  var cursorPoint: CGPoint? { cursor?.at }

  func start() {
    guard window == nil, let screen = NSScreen.screens.first else { return }
    let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    w.level = .screenSaver
    w.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    w.ignoresMouseEvents = true
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = false
    w.isReleasedWhenClosed = false
    w.animationBehavior = .none
    let content = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
    let ring = RingView(frame: content.bounds)
    let cursor = CursorView(frame: content.bounds)
    let pill = PillView(frame: .zero)
    ring.autoresizingMask = [.width, .height]
    cursor.autoresizingMask = [.width, .height]
    content.addSubview(ring)
    pill.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(pill)
    NSLayoutConstraint.activate([
      pill.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      pill.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -28),
      pill.widthAnchor.constraint(lessThanOrEqualToConstant: 720),
      pill.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -32),
    ])
    content.addSubview(cursor)
    w.contentView = content
    w.orderFrontRegardless()
    (self.window, self.ring, self.cursor, self.pill) = (w, ring, cursor, pill)
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in Task { @MainActor in self?.fitScreen() } }
  }

  private func fitScreen() {
    guard let w = window, let screen = NSScreen.screens.first else { return }
    w.setFrame(screen.frame, display: true)
    ring?.layout(for: screen.frame.size)
  }

  // overlay {state, subtitle?, cursor?, ring?}
  func apply(state s: State, subtitle: String?, cursor to: CGPoint?, ring: Bool?) {
    state = s
    if let ring { serverRing = ring }
    updateRing()
    if let pill {
      pill.orb.set(s)
      if let subtitle { pill.text.stringValue = String(subtitle.prefix(600)) }
      let words: [State: String] = [.listening: "Listening", .thinking: "Thinking"]
      pill.hint.stringValue = pill.text.stringValue.isEmpty ? (words[s] ?? "") : ""
      pill.hint.isHidden = pill.hint.stringValue.isEmpty
      pill.text.isHidden = pill.text.stringValue.isEmpty
      let visible = s != .idle || !pill.text.stringValue.isEmpty
      hideTimer?.invalidate()
      hideTimer = nil
      pill.show(visible)
      if visible, s == .idle {
        // Idle with words on the card: leave time to read them, then fade.
        let words = pill.text.stringValue.split(separator: " ").count
        let secs = min(60, max(10, 10 + Double(max(0, words - 15)) * 0.3))
        hideTimer = Timer.scheduledTimer(withTimeInterval: secs, repeats: false) { [weak self] _ in
          Task { @MainActor in
            guard let self, self.state == .idle else { return }
            self.pill?.show(false)
            self.pill?.text.stringValue = ""
          }
        }
      }
    }
    if let to { glide(to: to) }
  }

  func beginAction() { acting += 1; updateRing() }
  func endAction() { acting = max(0, acting - 1); updateRing() }

  private func updateRing() { ring?.set(serverRing || acting > 0) }

  func cursorAt(_ p: CGPoint) {
    glide?.cancel()
    cursor?.move(to: p)
  }

  func press(_ p: CGPoint) { cursor?.press(at: p) }

  func highlight(_ r: CGRect) { cursor?.highlight(r) }

  // Only the drawn cursor, not the real pointer (that is input's job).
  private func glide(to p: CGPoint) {
    glide?.cancel()
    guard let cursor else { return }
    guard let from = cursor.at, !reduceMotion() else { cursor.move(to: p); return }
    let path = planPath(from: Point(x: from.x, y: from.y), to: Point(x: p.x, y: p.y), rng: &rng)
    glide = Task { @MainActor [weak self] in
      for step in path {
        if step.ms > 0 { try? await Task.sleep(nanoseconds: UInt64(step.ms * 1_000_000)) }
        if Task.isCancelled { return }
        self?.cursor?.move(to: CGPoint(x: step.x, y: step.y))
      }
    }
  }
}
