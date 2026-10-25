import Foundation

// Framing on the Unix socket to the server (agent/desktop/link.ts): a
// 4-byte big-endian length, then that many bytes: one type byte (1 = JSON
// text, 2 = binary audio) and the payload.
public enum Frame {
  public static let json: UInt8 = 1
  public static let binary: UInt8 = 2
  public static let maxPayload = 32 * 1024 * 1024

  public static func encode(_ type: UInt8, _ payload: Data) -> Data {
    var out = Data(capacity: payload.count + 5)
    let n = UInt32(payload.count + 1).bigEndian
    withUnsafeBytes(of: n) { out.append(contentsOf: $0) }
    out.append(type)
    out.append(payload)
    return out
  }
}

// Splits a byte stream into frames. push returns false, and the stream
// must be dropped, on an empty, oversized or unknown frame.
public struct FrameDecoder {
  private var buf = Data()
  public init() {}

  public mutating func push(_ chunk: Data, _ onFrame: (UInt8, Data) -> Void) -> Bool {
    buf.append(chunk)
    while buf.count >= 4 {
      let b = buf.startIndex
      let len = Int(buf[b]) << 24 | Int(buf[b + 1]) << 16 | Int(buf[b + 2]) << 8 | Int(buf[b + 3])
      guard len >= 1, len <= Frame.maxPayload + 1 else { return false }
      guard buf.count >= 4 + len else { return true }
      let type = buf[b + 4]
      guard type == Frame.json || type == Frame.binary else { return false }
      let payload = buf.subdata(in: (b + 5)..<(b + 4 + len))
      buf = buf.subdata(in: (b + 4 + len)..<buf.endIndex)
      onFrame(type, payload)
    }
    return true
  }
}
