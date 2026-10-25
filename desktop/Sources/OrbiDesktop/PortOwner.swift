import Darwin

// Who listens on the server's port. The helper only dials when a process of
// this same user has a TCP socket listening there on 127.0.0.1 or on every
// address, so another account's process that grabbed the port cannot pose
// as the Orbi server and drive this Mac. (The token in hello is the
// server's check the other way.) Other users' processes are not readable
// here, which is the point: a listener we cannot see is not ours.
enum PortOwner {
  static func listenerIsOurs(port: Int) -> Bool {
    let uid = getuid()
    let pidSize = MemoryLayout<pid_t>.stride
    let bytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
    guard bytes > 0 else { return false }
    var pids = [pid_t](repeating: 0, count: Int(bytes) / pidSize + 64)
    let got = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, Int32(pids.count * pidSize))
    for pid in pids.prefix(max(0, Int(got) / pidSize)) where pid > 0 {
      var bsd = proc_bsdinfo()
      let bsdSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
      guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, bsdSize) == bsdSize, bsd.pbi_uid == uid else { continue }
      if listens(pid: pid, port: port) { return true }
    }
    return false
  }

  private static func listens(pid: pid_t, port: Int) -> Bool {
    let fdSize = MemoryLayout<proc_fdinfo>.stride
    let fdBytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
    guard fdBytes > 0 else { return false }
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
        if a == 0 || a == UInt32(0x7f00_0001).bigEndian { return true }
      } else if ini.insi_vflag & UInt8(INI_IPV6) != 0 {
        // A dual-stack wildcard (::) also takes 127.0.0.1.
        if withUnsafeBytes(of: ini.insi_laddr.ina_6, { $0.allSatisfy { $0 == 0 } }) { return true }
      }
    }
    return false
  }
}
