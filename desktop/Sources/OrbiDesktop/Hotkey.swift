import AppKit
import OrbiDesktopCore

// The global talk key: Right Option, held to talk, double-tapped to latch
// (the timing lives in OrbiDesktopCore/PushToTalk). Watched with NSEvent
// flagsChanged monitors, which need Accessibility; install() is called
// again when that permission arrives. The key is only observed, never
// swallowed.
@MainActor
final class Hotkey {
  var onActions: ([PushToTalk.Action]) -> Void = { _ in }

  let keyCode: UInt16 = KeyCode.rightOption
  private static let rightOptionMask: UInt = 0x40 // NX_DEVICERALTKEYMASK
  private var machine = PushToTalk()
  private var monitors: [Any] = []
  private var ticker: Timer?
  private var isDown = false

  private var now: Double { ProcessInfo.processInfo.systemUptime * 1000 }

  func install() {
    remove()
    if let g = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { [weak self] e in
      Task { @MainActor in self?.handle(e) }
    }) { monitors.append(g) }
    if let l = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { [weak self] e in
      Task { @MainActor in self?.handle(e) }
      return e
    }) { monitors.append(l) }
  }

  func remove() {
    for m in monitors { NSEvent.removeMonitor(m) }
    monitors = []
    isDown = false
    emit(machine.cancel())
  }

  private func handle(_ e: NSEvent) {
    guard e.keyCode == keyCode else { return }
    let down = (e.modifierFlags.rawValue & Self.rightOptionMask) != 0
    guard down != isDown else { return }
    isDown = down
    emit(down ? machine.down(at: now) : machine.up(at: now))
  }

  private func emit(_ actions: [PushToTalk.Action]) {
    if !actions.isEmpty { onActions(actions) }
    // Tick while anything is pending, so holds confirm and taps expire.
    if machine.state == .idle {
      ticker?.invalidate()
      ticker = nil
    } else if ticker == nil {
      ticker = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          self.emit(self.machine.tick(at: self.now))
        }
      }
    }
  }
}
