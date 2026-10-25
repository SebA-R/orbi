import Foundation

// Hold-to-talk on one key, with double-tap to latch, mirroring the
// extension's hotkey: the mic opens the moment the key goes down, but the
// server hears ptt_down only once it has been held confirmMs, then gets the
// buffered audio from the first moment. Letting go sends ptt_up. A shorter
// tap sends nothing and its audio is thrown away. A second press within
// doubleTapMs of a tap latches (latch_toggle, audio keeps streaming); while
// latched the next press unlatches (latch_toggle) and is consumed. A latch
// ends by itself after maxLatchMs.
//
// Pure and clocked by the caller (milliseconds, any monotonic origin); the
// app calls tick(at:) from a timer so a hold confirms while still down.
public struct PushToTalk {
  public enum Action: Equatable, Sendable {
    case micOpen      // start capturing into the local buffer
    case micStream    // send ptt_down-era audio: flush the buffer, then stream
    case micClose     // stop capturing, drop anything unsent
    case send(PTTEvent)
    case stopPlayback // barge in on our own TTS at once
  }

  public enum State: Equatable, Sendable {
    case idle
    case pressed(at: Double)  // down, not yet a hold
    case holding              // confirmed, ptt_down sent
    case tapped(at: Double)   // a tap just ended; a second press latches
    case latched(at: Double)
    case unlatching           // the press that ended a latch is still down
  }

  public let confirmMs: Double
  public let doubleTapMs: Double
  public let maxLatchMs: Double
  public private(set) var state: State = .idle

  public init(confirmMs: Double = 200, doubleTapMs: Double = 350, maxLatchMs: Double = 300_000) {
    self.confirmMs = confirmMs
    self.doubleTapMs = doubleTapMs
    self.maxLatchMs = maxLatchMs
  }

  public mutating func down(at t: Double) -> [Action] {
    var out = tick(at: t)
    switch state {
    case .idle:
      state = .pressed(at: t)
      out.append(.micOpen)
    case .tapped:
      state = .latched(at: t)
      out += [.micOpen, .micStream, .send(.latchToggle), .stopPlayback]
    case .latched:
      state = .unlatching
      out += [.micClose, .send(.latchToggle)]
    case .pressed, .holding, .unlatching:
      break // key repeat or a missed up: ignore
    }
    return out
  }

  public mutating func up(at t: Double) -> [Action] {
    var out = tick(at: t)
    switch state {
    case .pressed:
      state = .tapped(at: t)
      out.append(.micClose)
    case .holding:
      state = .idle
      out += [.micClose, .send(.pttUp)]
    case .unlatching:
      state = .idle
    case .idle, .tapped, .latched:
      break // the release of the latching press, or a stray up
    }
    return out
  }

  public mutating func tick(at t: Double) -> [Action] {
    switch state {
    case .pressed(let at) where t - at >= confirmMs:
      state = .holding
      return [.send(.pttDown), .micStream, .stopPlayback]
    case .tapped(let at) where t - at > doubleTapMs:
      state = .idle
    case .latched(let at) where t - at >= maxLatchMs:
      state = .idle
      return [.micClose, .send(.latchToggle)]
    default:
      break
    }
    return []
  }

  // The app lost the key (permission revoked, quit): end whatever is open.
  public mutating func cancel() -> [Action] {
    defer { state = .idle }
    switch state {
    case .pressed: return [.micClose]
    case .holding: return [.micClose, .send(.pttUp)]
    case .latched: return [.micClose, .send(.latchToggle)]
    default: return []
    }
  }
}
