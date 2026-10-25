import AppKit
import CoreGraphics
import OrbiDesktopCore

// Mouse and keyboard through CGEvent, at a watchable human pace (the plans
// come from OrbiDesktopCore/Humanize.swift). The drawn cursor follows the
// real pointer along the path. `allowed` is asked again right before every
// press and every key, so an app that comes to the front mid-gesture (a
// blocked one, a password field) stops the action before anything lands.
@MainActor
final class Input {
  enum Button: String { case left, right, middle }

  private let overlay: Overlay
  private var rng = Rng()
  private let source = CGEventSource(stateID: .hidSystemState)
  // Bumped by cancelAll(); a running gesture stops at its next step.
  private var epoch = 0

  init(overlay: Overlay) { self.overlay = overlay }

  func cancelAll() { epoch += 1 }

  var pointer: CGPoint { CGEvent(source: nil)?.location ?? .zero }

  private func sleep(_ ms: Double, _ started: Int) async throws {
    if ms > 0 { try await Task.sleep(nanoseconds: UInt64(ms * 1_000_000)) }
    if started != epoch || Task.isCancelled { throw ProtoError(.internalError, "cancelled") }
  }

  private func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

  private func moveEvent(_ p: CGPoint) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  }

  // Glide the real pointer (and the drawn cursor) to p.
  func move(to p: CGPoint, size: Double?) async throws {
    let started = epoch
    let from = pointer
    let path = reduceMotionOn
      ? [PathStep(x: p.x, y: p.y, ms: 0)]
      : planPath(from: Point(x: from.x, y: from.y), to: Point(x: p.x, y: p.y), rng: &rng, size: size)
    for step in path {
      try await sleep(step.ms, started)
      let q = CGPoint(x: step.x, y: step.y)
      moveEvent(q)
      overlay.cursorAt(q)
    }
  }

  private var reduceMotionOn: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  func click(at p: CGPoint, size: Double?, button: Button, count: Int, allowed: () throws -> Void) async throws {
    let started = epoch
    let plan = planClick(from: Point(x: pointer.x, y: pointer.y), to: Point(x: p.x, y: p.y), rng: &rng, size: size)
    try await move(to: p, size: size)
    try await sleep(plan.dwellMs, started)
    try allowed()
    let (down, up, cg): (CGEventType, CGEventType, CGMouseButton) = switch button {
    case .left: (.leftMouseDown, .leftMouseUp, .left)
    case .right: (.rightMouseDown, .rightMouseUp, .right)
    case .middle: (.otherMouseDown, .otherMouseUp, .center)
    }
    for i in 1...count {
      if i > 1 { try await sleep(rng.between(70, 120).rounded(), started); try allowed() }
      overlay.press(p)
      let d = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: p, mouseButton: cg)
      d?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
      d?.flags = []
      post(d)
      // Released even if cancelled now, so no button is left down.
      try? await Task.sleep(nanoseconds: UInt64(plan.holdMs * 1_000_000))
      let u = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: p, mouseButton: cg)
      u?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
      u?.flags = []
      post(u)
    }
  }

  private func flags(_ m: Modifiers) -> CGEventFlags {
    var f: CGEventFlags = []
    if m.contains(.cmd) { f.insert(.maskCommand) }
    if m.contains(.shift) { f.insert(.maskShift) }
    if m.contains(.alt) { f.insert(.maskAlternate) }
    if m.contains(.ctrl) { f.insert(.maskControl) }
    if m.contains(.fn) { f.insert(.maskSecondaryFn) }
    return f
  }

  func key(_ combo: KeyCombo, allowed: () throws -> Void) async throws {
    let started = epoch
    try allowed()
    let f = flags(combo.modifiers)
    let d = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: true)
    d?.flags = f
    post(d)
    try? await Task.sleep(nanoseconds: UInt64(rng.between(40, 80) * 1_000_000))
    let u = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: false)
    u?.flags = f
    post(u)
    try await sleep(0, started)
  }

  // Every character is its own key press, with explicit flags so a held
  // modifier (like the talk key) never combines with it.
  func type(_ text: String, allowed: () throws -> Void) async throws {
    let started = epoch
    for step in planTyping(text, rng: &rng) {
      try await sleep(step.gapMs, started)
      try allowed()
      let k = usKey(for: step.ch)
      let units = Array(String(step.ch).utf16)
      let isControl = step.ch == "\n" || step.ch == "\r" || step.ch == "\r\n" || step.ch == "\t"
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: k?.code ?? 0, keyDown: down)
        e?.flags = (k?.shift ?? false) ? .maskShift : []
        if !isControl { e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units) }
        post(e)
        if down { try? await Task.sleep(nanoseconds: UInt64(step.holdMs * 1_000_000)) }
      }
    }
  }

  // dx, dy in points; positive dy scrolls the content down (like a DOM
  // wheel deltaY), positive dx scrolls right.
  func scroll(at p: CGPoint, dx: Int, dy: Int, allowed: () throws -> Void) async throws {
    let started = epoch
    try await move(to: p, size: nil)
    try allowed()
    for step in planScroll(dx: dx, dy: dy, rng: &rng) {
      try await sleep(step.ms, started)
      try allowed()
      let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                      wheel1: Int32(clamping: -step.dy), wheel2: Int32(clamping: -step.dx), wheel3: 0)
      e?.flags = []
      e?.location = p // the checked point, wherever the user's hand moved the pointer
      post(e)
    }
  }
}
