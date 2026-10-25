import Foundation

// A plain JSON value, so protocol messages can be decoded without a struct
// per method and request ids are echoed back exactly as they came.
public enum JSON: Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSON])
  case object([String: JSON])

  public subscript(key: String) -> JSON? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public var string: String? { if case .string(let s) = self { return s }; return nil }
  public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
  public var double: Double? {
    if case .number(let n) = self, n.isFinite { return n }
    return nil
  }
  public var int: Int? {
    guard let d = double, d.rounded() == d, abs(d) < 9.0e15 else { return nil }
    return Int(d)
  }
  public var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
  public var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
}

extension JSON: Codable {
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSON].self) { self = .array(a) }
    else if let o = try? c.decode([String: JSON].self) { self = .object(o) }
    else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "not JSON") }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n.isFinite ? n : 0)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
  public init(stringLiteral v: String) { self = .string(v) }
  public init(booleanLiteral v: Bool) { self = .bool(v) }
  public init(integerLiteral v: Int) { self = .number(Double(v)) }
  public init(floatLiteral v: Double) { self = .number(v) }
  public init(arrayLiteral v: JSON...) { self = .array(v) }
  public init(dictionaryLiteral v: (String, JSON)...) { self = .object(Dictionary(v, uniquingKeysWith: { _, b in b })) }
  public init(nilLiteral: ()) { self = .null }
}

extension JSON {
  public init(_ s: String?) { self = s.map { .string($0) } ?? .null }
  public init(_ d: Double) { self = .number(d) }
  public init(_ i: Int) { self = .number(Double(i)) }
  public init(_ b: Bool) { self = .bool(b) }

  public func encoded() -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? enc.encode(self), let s = String(data: data, encoding: .utf8) else { return "null" }
    return s
  }

  public static func decode(_ text: String) throws -> JSON {
    try JSONDecoder().decode(JSON.self, from: Data(text.utf8))
  }
}
