import Darwin

// Who listens on the server's port. The helper only dials when a process of
// this same user has a TCP socket listening there on 127.0.0.1, ::1 or every
// address, so another account's process that grabbed the port is never
// dialled. (The handshake proof is the real check: see Handshake.) Other users' processes are not readable
// here, which is the point: a listener we cannot see is not ours.
enum PortOwner {
  enum Loopback { case v4, v6Loopback }

  // .v4 when ours takes 127.0.0.1 (directly, or as a wildcard), .v6Loopback
  // when ours listens on ::1 only, nil when none of ours listens.
  static func ourListener(port: Int) -> Loopback? {
    let uid = getuid()
    let pidSize = MemoryLayout<pid_t>.stride
    let bytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
    guard bytes > 0 else { return nil }
    var pids = [pid_t](repeating: 0, count: Int(bytes) / pidSize + 64)
    let got = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, Int32(pids.count * pidSize))
    var found: Loopback?
    for pid in pids.prefix(max(0, Int(got) / pidSize)) where pid > 0 {
      var bsd = proc_bsdinfo()
      let bsdSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
      guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, bsdSize) == bsdSize, bsd.pbi_uid == uid else { continue }
      switch listens(pid: pid, port: port) {
      case .v4?: return .v4
      case .v6Loopback?: found = .v6Loopback
      case nil: break
      }
    }
    return found
  }

  private static func listens(pid: pid_t, port: Int) -> Loopback? {
    var found: Loopback?
    let fdSize = MemoryLayout<proc_fdinfo>.stride
    let fdBytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
    guard fdBytes > 0 else { return nil }
    var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(fdBytes) / fdSize)
    let got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &fds, Int32(fds.count * fdSize))
    for fd in fds.prefix(max(0, Int(got) / fdSize)) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
      var si = socket_fdinfo()
      let siSize = Int32(MemoryLayout<socket_fdinfo>.stride)
      guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &si, siSize) == siSize,
            si.psi.soi_kind == Int32(SOCKINFO_TCP) else { continue }
      let tcp = si.psi.soi_proto.pri_tcp
      guard tcp.tcpsi_state == TSI_S_LISTEN else { continue }
      let ini = tcp.tcpsi_ini
      guard Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: ini.insi_lport))) == port else { continue }
      if ini.insi_vflag & UInt8(INI_IPV4) != 0 {
        let a = ini.insi_laddr.ina_46.i46a_addr4.s_addr
        if a == 0 || a == UInt32(0x7f00_0001).bigEndian { return .v4 }
      } else if ini.insi_vflag & UInt8(INI_IPV6) != 0 {
        let bytes = withUnsafeBytes(of: ini.insi_laddr.ina_6) { Array($0) }
        // A dual-stack wildcard (::) also takes 127.0.0.1.
        if bytes.allSatisfy({ $0 == 0 }) { return .v4 }
        if bytes.dropLast().allSatisfy({ $0 == 0 }) && bytes.last == 1 { found = .v6Loopback }
      }
    }
    return found
  }
}
