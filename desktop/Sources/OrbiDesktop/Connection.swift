import Foundation
import OrbiDesktopCore

// The WebSocket to the Orbi server. The helper is the client: it says hello,
// waits for welcome, then answers requests. If the server is down or the
// socket drops it reconnects with jittered exponential backoff (0.5 s
// doubling to 10 s). A ping every 15 s notices a dead socket.
@MainActor
final class Connection {
  enum Status { case connecting, connected }

  var onStatus: (Status) -> Void = { _ in }
  var onMessage: (Inbound) -> Void = { _ in }
  var onBinary: (Data) -> Void = { _ in }
  var onDisconnect: () -> Void = {}
  var makeHello: () -> String = { Outbound.hello(Perms.current) }

  private let url: URL
  private let session = URLSession(configuration: .ephemeral)
  private var task: URLSessionWebSocketTask?
  private var generation = 0
  private var attempt = 0
  private var welcomed = false
  private var pingTimer: Timer?
  private var retryTimer: Timer?

  init(url: URL) { self.url = url }

  var isConnected: Bool { welcomed }

  func start() { connect() }

  // Drop the socket and dial again now, e.g. so a new hello carries
  // permissions the user just granted.
  func restart() {
    attempt = 0
    drop()
    connect()
  }

  func send(text: String) {
    guard let task else { return }
    task.send(.string(text)) { [weak self] err in
      if let err { Task { @MainActor in self?.failed(task, err) } }
    }
  }

  func send(binary: Data) {
    guard welcomed, let task else { return }
    task.send(.data(binary)) { _ in }
  }

  private func connect() {
    retryTimer?.invalidate()
    retryTimer = nil
    generation += 1
    welcomed = false
    onStatus(.connecting)
    let t = session.webSocketTask(with: url)
    t.maximumMessageSize = 16 << 20
    task = t
    t.resume()
    log("connecting to \(url.absoluteString)")
    send(text: makeHello())
    receive(t, generation)
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.ping() }
    }
  }

  private func ping() {
    guard let t = task else { return }
    t.sendPing { [weak self] err in
      if let err { Task { @MainActor in self?.failed(t, err) } }
    }
  }

  private func receive(_ t: URLSessionWebSocketTask, _ gen: Int) {
    t.receive { [weak self] result in
      Task { @MainActor in
        guard let self, gen == self.generation else { return }
        switch result {
        case .failure(let err):
          self.failed(t, err)
        case .success(let msg):
          self.handle(msg)
          self.receive(t, gen)
        }
      }
    }
  }

  private func handle(_ msg: URLSessionWebSocketTask.Message) {
    switch msg {
    case .data(let d):
      if welcomed { onBinary(d) }
    case .string(let s):
      let inbound: Inbound
      do { inbound = try decodeInbound(s) } catch {
        log("dropped a malformed frame (\(error))")
        return
      }
      if case .welcome(let v, _) = inbound {
        guard v == Proto.version else {
          log("server speaks version \(v), want \(Proto.version); retrying later")
          failed(task, nil)
          return
        }
        welcomed = true
        attempt = 0
        onStatus(.connected)
        log("welcomed")
      }
      guard welcomed else { return } // nothing is answered before welcome
      onMessage(inbound)
    @unknown default:
      break
    }
  }

  private func failed(_ t: URLSessionWebSocketTask?, _ err: Error?) {
    guard t === task else { return } // an old socket
    if let err { log("socket closed: \(err.localizedDescription)") }
    let wasWelcomed = welcomed
    drop()
    if wasWelcomed { onStatus(.connecting) }
    let delay = min(10, 0.5 * pow(2, Double(attempt))) * Double.random(in: 0.8...1.2)
    attempt = min(attempt + 1, 8)
    retryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      Task { @MainActor in self?.connect() }
    }
  }

  private func drop() {
    generation += 1
    pingTimer?.invalidate()
    pingTimer = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    if welcomed {
      welcomed = false
      onDisconnect()
    }
  }
}
