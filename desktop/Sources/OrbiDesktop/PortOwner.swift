import Darwin

// Who holds the server's port. The helper only dials, and only keeps a
// welcomed connection, when every TCP socket of this user bound to that
// local port (listening or accepted) belongs to ONE process, and that
// process listens on 127.0.0.1, ::1 or every address.
//
// Why: the server listens on the dual-stack wildcard, and another process
// can bind 127.0.0.1 on the same port on top of it (SO_REUSEADDR), take
// the helper's connection and relay the handshake to the real server: the
// proofs pass, but the relay then sits in the middle. A relay needs a
// socket of its own on the port, listening or accepted, in a second
// process, which this check sees. Checked before dialing and again after
// welcome, so a relay that closes its listener once it has the connection
// is still caught by its accepted socket. Other users' processes are not
// readable here, but macOS does not let another user bind over a port that
// this user holds.
enum PortOwner {
  enum Loopback { case v4, v6Loopback }

  private struct Sock {
    let listening: Bool
    let wildcard: Bool
    let v4Loopback: Bool
    let v6Loopback: Bool
  }

  // Where to dial (.v4: 127.0.0.1, .v6Loopback: ::1), or nil when the port
  // is not held by exactly one process of ours that listens on loopback.
  static func ourListener(port: Int) -> Loopback? {
    let uid = getuid()
    let pidSize = MemoryLayout<pid_t>.stride
    let bytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
    guard bytes > 0 else { return nil }
    var pids = [pid_t](repeating: 0, count: Int(bytes) / pidSize + 64)
    let got = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, Int32(pids.count * pidSize))
    var holders: [pid_t: [Sock]] = [:]
    for pid in pids.prefix(max(0, Int(got) / pidSize)) where pid > 0 {
      var bsd = proc_bsdinfo()
      let bsdSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
      guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, bsdSize) == bsdSize, bsd.pbi_uid == uid else { continue }
      let socks = sockets(pid: pid, port: port)
      if !socks.isEmpty { holders[pid] = socks }
    }
    guard holders.count == 1, let socks = holders.first?.value else { return nil }
    let listen = socks.filter(\.listening)
    if listen.contains(where: { $0.wildcard || $0.v4Loopback }) { return .v4 }
    if listen.contains(where: \.v6Loopback) { return .v6Loopback }
    return nil
  }

  // This process's TCP sockets whose local port is `port`.
  private static func sockets(pid: pid_t, port: Int) -> [Sock] {
    let fdSize = MemoryLayout<proc_fdinfo>.stride
    let fdBytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
    guard fdBytes > 0 else { return [] }
    var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(fdBytes) / fdSize)
    let got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &fds, Int32(fds.count * fdSize))
    var out: [Sock] = []
    for fd in fds.prefix(max(0, Int(got) / fdSize)) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
      var si = socket_fdinfo()
      let siSize = Int32(MemoryLayout<socket_fdinfo>.stride)
      guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &si, siSize) == siSize,
            si.psi.soi_kind == Int32(SOCKINFO_TCP) else { continue }
      let tcp = si.psi.soi_proto.pri_tcp
      let ini = tcp.tcpsi_ini
      guard Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: ini.insi_lport))) == port else { continue }
      var wildcard = false, v4 = false, v6 = false
      if ini.insi_vflag & UInt8(INI_IPV4) != 0 {
        let a = ini.insi_laddr.ina_46.i46a_addr4.s_addr
        wildcard = a == 0
        v4 = a == UInt32(0x7f00_0001).bigEndian
      } else if ini.insi_vflag & UInt8(INI_IPV6) != 0 {
        let b = withUnsafeBytes(of: ini.insi_laddr.ina_6) { Array($0) }
        wildcard = b.allSatisfy { $0 == 0 }
        v6 = b.dropLast().allSatisfy { $0 == 0 } && b.last == 1
      }
      out.append(Sock(listening: tcp.tcpsi_state == TSI_S_LISTEN, wildcard: wildcard, v4Loopback: v4, v6Loopback: v6))
    }
    return out
  }
}
