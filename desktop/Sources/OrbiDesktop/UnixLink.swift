import Darwin
import Foundation
import OrbiDesktopCore

// The Unix domain socket to the Orbi server (agent/desktop/link.ts), not
// TCP: no port to take, shadow or relay through. Before connecting, the
// socket must be this user's, in a directory of this user's that no one
// else can enter (mode 0700). After connecting, getpeereid must say the
// server runs as this user. The HMAC handshake (Handshake) runs on top.
//
// One reader thread per connection; frames are handed to the main queue.
// Writes go through a serial queue, in order.
final class UnixLink: @unchecked Sendable {
  private let fd: Int32
  private let writes = DispatchQueue(label: "orbi.link.write")
  private let lock = NSLock()
  private var closed = false

  struct Refused: Error, CustomStringConvertible {
    let description: String
  }

  static func connect(path: String) throws -> UnixLink {
    let uid = getuid()
    var st = stat()
    let dir = (path as NSString).deletingLastPathComponent
    guard lstat(dir, &st) == 0 else { throw Refused(description: "no directory \(dir)") }
    guard st.st_uid == uid, (st.st_mode & S_IFMT) == S_IFDIR, st.st_mode & 0o077 == 0 else {
      throw Refused(description: "\(dir) is not this user's private (0700) directory")
    }
    guard lstat(path, &st) == 0 else { throw Refused(description: "no socket at \(path); is the Orbi server running?") }
    guard st.st_uid == uid, (st.st_mode & S_IFMT) == S_IFSOCK else {
      throw Refused(description: "\(path) is not this user's socket")
    }

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Refused(description: "socket() failed") }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let cap = MemoryLayout.size(ofValue: addr.sun_path)
    guard bytes.count < cap else { close(fd); throw Refused(description: "socket path too long") }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, len) } }
    guard rc == 0 else { close(fd); throw Refused(description: "connect failed (\(String(cString: strerror(errno))))") }
    var peerUid: uid_t = 0, peerGid: gid_t = 0
    guard getpeereid(fd, &peerUid, &peerGid) == 0, peerUid == uid else {
      close(fd)
      throw Refused(description: "the server on \(path) is not this user")
    }
    return UnixLink(fd: fd)
  }

  private init(fd: Int32) { self.fd = fd }

  // Reads until the stream ends or a bad frame, on its own thread.
  func start(onFrame: @escaping @MainActor (UInt8, Data) -> Void, onClose: @escaping @MainActor () -> Void) {
    let fd = self.fd
    Thread.detachNewThread { [self] in
      var dec = FrameDecoder()
      var buf = [UInt8](repeating: 0, count: 64 * 1024)
      while true {
        let n = read(fd, &buf, buf.count)
        if n <= 0 { break }
        let ok = dec.push(Data(buf[0..<n])) { type, payload in
          DispatchQueue.main.async { MainActor.assumeIsolated { onFrame(type, payload) } }
        }
        if !ok { break }
      }
      self.shutdown()
      self.writes.async { close(fd) } // after any queued write
      DispatchQueue.main.async { MainActor.assumeIsolated { onClose() } }
    }
  }

  func send(_ type: UInt8, _ payload: Data) {
    let frame = Frame.encode(type, payload)
    let fd = self.fd
    writes.async { [self] in
      guard !self.isClosed else { return }
      frame.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
          let n = write(fd, raw.baseAddress! + off, raw.count - off)
          if n <= 0 { if errno == EINTR { continue }; self.shutdown(); return }
          off += n
        }
      }
    }
  }

  private var isClosed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return closed
  }

  // Ends the stream; the reader thread then closes the descriptor.
  func shutdown() {
    lock.lock()
    let first = !closed
    closed = true
    lock.unlock()
    if first { Darwin.shutdown(fd, SHUT_RDWR) }
  }
}
