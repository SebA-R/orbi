import Foundation
import OrbiDesktopCore

// The link to the Orbi server: a Unix domain socket (UnixLink), framed JSON
// and audio. The helper is the client: it says hello with a nonce, checks
// the server's challenge proof (Handshake), answers with its own proof,
// waits for welcome, then answers requests. A server that cannot prove the
// token is dropped before it can ask for anything. If the server is down or
// the link drops it reconnects with jittered exponential backoff (0.5 s
// doubling to 10 s). A ping every 15 s with no pong in 10 s counts as a drop.
@MainActor
final class Connection {
  enum Status { case connecting, connected }

  var onStatus: (Status) -> Void = { _ in }
  var onMessage: (Inbound) -> Void = { _ in }
  var onBinary: (Data) -> Void = { _ in }
  var onDisconnect: () -> Void = {}

  private let path: String
  private var link: UnixLink?
  private var generation = 0
  private var attempt = 0
  private var welcomed = false
  private var pingTimer: Timer?
  private var retryTimer: Timer?
  private var pongTimer: Timer?
  private var pings = 0
  // This attempt's token and nonce, and whether the server proved the token.
  private var token = ""
  private var nonce = ""
  private var serverProved = false

  init(path: String) { self.path = path }

  var isConnected: Bool { welcomed }

  func start() { connect() }

  // Drop the link and dial again now, e.g. so a new hello carries
  // permissions the user just granted.
  func restart() {
    attempt = 0
    drop()
    connect()
  }

  func send(text: String) {
    link?.send(Frame.json, Data(text.utf8))
  }

  func send(binary: Data) {
    guard welcomed else { return }
    link?.send(Frame.binary, binary)
  }

  private func connect() {
    retryTimer?.invalidate()
    retryTimer = nil
    generation += 1
    welcomed = false
    serverProved = false
    onStatus(.connecting)
    // No token yet means the server has not started: try again later.
    guard let token = Env.token() else {
      log("no token at \(Env.tokenFile.path); is the Orbi server running?")
      return retry()
    }
    let l: UnixLink
    do { l = try UnixLink.connect(path: path) } catch {
      log("not connecting: \(error)")
      return retry()
    }
    self.token = token
    nonce = Handshake.nonce()
    link = l
    let gen = generation
    l.start(
      onFrame: { [weak self] type, payload in
        guard let self, gen == self.generation else { return }
        self.handle(type, payload)
      },
      onClose: { [weak self] in
        guard let self, gen == self.generation else { return }
        log("link closed")
        self.failed()
      }
    )
    log("connected to \(path)")
    send(text: Outbound.hello(Perms.current, nonce: nonce))
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.ping() }
    }
  }

  private func ping() {
    guard link != nil else { return }
    pings += 1
    send(text: JSON.object(["type": "ping", "t": JSON(pings)]).encoded())
    if pongTimer == nil {
      pongTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
        Task { @MainActor in
          log("no pong in 10 s")
          self?.failed()
        }
      }
    }
  }

  private func handle(_ type: UInt8, _ payload: Data) {
    if type == Frame.binary {
      if welcomed { onBinary(payload) }
      return
    }
    guard let s = String(data: payload, encoding: .utf8) else { return }
    let inbound: Inbound
    do { inbound = try decodeInbound(s) } catch {
      log("dropped a malformed frame (\(error))")
      return
    }
    switch inbound {
    case .unknown(type: "pong"):
      pongTimer?.invalidate()
      pongTimer = nil
      return
    case .unknown(type: "close"):
      log("the server closed the link")
      return failed()
    case .challenge(let serverNonce, let proof):
      let expected = Handshake.serverProof(token: token, helperNonce: nonce, serverNonce: serverNonce)
      guard !serverProved, !welcomed, Handshake.matches(expected, proof), serverNonce != nonce else {
        log("the server could not prove the token; not talking to it")
        return failed()
      }
      serverProved = true
      send(text: Outbound.auth(proof: Handshake.helperProof(token: token, serverNonce: serverNonce, helperNonce: nonce)))
      return
    case .welcome(let v, _):
      guard serverProved, !welcomed else {
        log("welcome without a proven token; dropping")
        return failed()
      }
      guard v == Proto.version else {
        log("server speaks version \(v), want \(Proto.version); retrying later")
        return failed()
      }
      welcomed = true
      attempt = 0
      onStatus(.connected)
      log("welcomed")
    default:
      break
    }
    guard welcomed else { return } // nothing is answered before welcome
    onMessage(inbound)
  }

  private func failed() {
    guard link != nil || welcomed else { return }
    let wasWelcomed = welcomed
    drop()
    if wasWelcomed { onStatus(.connecting) }
    retry()
  }

  private func retry() {
    retryTimer?.invalidate()
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
    pongTimer?.invalidate()
    pongTimer = nil
    link?.shutdown()
    link = nil
    serverProved = false
    if welcomed {
      welcomed = false
      onDisconnect()
    }
  }
}
