import Foundation

// What a screenshot must black out, decided from recognized text. The app
// runs Vision text recognition and hands every line here as a TextLine;
// this returns the character ranges to cover. It errs toward covering:
//
// - Card numbers: a digit run (one or two spaces or dashes allowed between
//   digits, since OCR doubles spaces) is covered whole when any 13 to 19
//   digit window of it passes Luhn, since a space can join a card number to
//   its expiry, CVC or other neighbours.
// - One-time codes: a standalone run of exactly 6 digits ("123456",
//   "123 456", "123-456") when "code", "verification", "otp" or "passcode"
//   appears on the same line or on a line close to it.

public struct Box: Equatable, Sendable {
  public var x: Double, y: Double, w: Double, h: Double
  public init(x: Double, y: Double, w: Double, h: Double) {
    self.x = x; self.y = y; self.w = w; self.h = h
  }
  public var maxX: Double { x + w }
  public var maxY: Double { y + h }
}

public struct TextLine: Sendable {
  public let text: String
  public let box: Box // any consistent space; only used for nearness
  public init(text: String, box: Box) {
    self.text = text
    self.box = box
  }
}

public struct RedactHit: Equatable, Sendable {
  public enum Kind: Sendable { case card, code }
  public let line: Int
  public let range: Range<String.Index>
  public let kind: Kind
}

public enum Luhn {
  public static func valid<S: Sequence>(_ digits: S) -> Bool where S.Element == Int {
    let ds = Array(digits)
    guard !ds.isEmpty else { return false }
    var sum = 0
    for (i, d) in ds.reversed().enumerated() {
      guard (0...9).contains(d) else { return false }
      if i % 2 == 1 {
        let x = d * 2
        sum += x > 9 ? x - 9 : x
      } else {
        sum += d
      }
    }
    return sum % 10 == 0
  }

  public static func valid(_ s: String) -> Bool {
    let ds = s.compactMap(\.wholeNumberValue)
    return ds.count == s.filter { !$0.isWhitespace && $0 != "-" }.count && valid(ds)
  }
}

// A maximal run of ASCII digits with at most two spaces or dashes between
// two digits.
struct DigitRun {
  let range: Range<String.Index>
  let digits: [Int]
  // The separator-free pieces of the run ("4111", "1111", ...), each with
  // its digit count.
  let groups: [(range: Range<String.Index>, count: Int)]
}

func digitRuns(in s: String) -> [DigitRun] {
  var runs: [DigitRun] = []
  var i = s.startIndex
  func isDigit(_ c: Character) -> Bool { c.isASCII && c.isNumber }
  func isSep(_ c: Character) -> Bool { c == " " || c == "-" || c == "\u{00A0}" }
  while i < s.endIndex {
    guard isDigit(s[i]) else { i = s.index(after: i); continue }
    let start = i
    var end = s.index(after: i)
    var digits = [s[i].wholeNumberValue!]
    var groups: [(range: Range<String.Index>, count: Int)] = []
    var groupStart = start
    var groupCount = 1
    var j = end
    while j < s.endIndex {
      if isDigit(s[j]) {
        if j != end { // a separator came before this digit
          groups.append((groupStart..<end, groupCount))
          groupStart = j
          groupCount = 0
        }
        digits.append(s[j].wholeNumberValue!)
        groupCount += 1
        j = s.index(after: j)
        end = j
      } else if isSep(s[j]) {
        // One or two separators, then a digit.
        var k = s.index(after: j)
        if k < s.endIndex, isSep(s[k]) { k = s.index(after: k) }
        guard k < s.endIndex, isDigit(s[k]) else { break }
        j = k
      } else {
        break
      }
    }
    groups.append((groupStart..<end, groupCount))
    runs.append(DigitRun(range: start..<end, digits: digits, groups: groups))
    i = end
  }
  return runs
}

public enum Redaction {
  public static let codeWords = ["code", "verification", "otp", "passcode"]

  // Any 13 to 19 digit window of the run passing Luhn: a card may sit next
  // to an expiry, a CVC or other digits that a space joined onto it.
  static func isCard(_ digits: [Int]) -> Bool {
    let n = digits.count
    guard n >= 13 else { return false }
    for len in 13...min(19, n) {
      for start in 0...(n - len) where Luhn.valid(digits[start..<(start + len)]) {
        return true
      }
    }
    return false
  }

  static func mentionsCode(_ s: String) -> Bool {
    let l = s.lowercased()
    return codeWords.contains { l.contains($0) }
  }

  // Lines whose boxes are within about two line heights of each other,
  // vertically, and overlap or nearly touch horizontally.
  static func near(_ a: Box, _ b: Box) -> Bool {
    let lineH = max(a.h, b.h, 1e-9)
    let vGap = max(0, max(a.y, b.y) - min(a.maxY, b.maxY))
    let hGap = max(0, max(a.x, b.x) - min(a.maxX, b.maxX))
    let width = max(a.w, b.w)
    return vGap <= lineH * 2.5 && hGap <= max(width * 0.5, lineH * 6)
  }

  static func standalone(_ s: String, _ r: Range<String.Index>) -> Bool {
    if r.lowerBound > s.startIndex {
      let c = s[s.index(before: r.lowerBound)]
      if c.isLetter || c.isNumber { return false }
    }
    if r.upperBound < s.endIndex {
      let c = s[r.upperBound]
      if c.isLetter || c.isNumber { return false }
    }
    return true
  }

  public static func hits(in lines: [TextLine]) -> [RedactHit] {
    var out: [RedactHit] = []
    let mentions = lines.map { mentionsCode($0.text) }
    for (li, line) in lines.enumerated() {
      for run in digitRuns(in: line.text) {
        if isCard(run.digits) {
          out.append(RedactHit(line: li, range: run.range, kind: .card))
        } else {
          // Six digits made of whole groups ("123456", "123 456"), even
          // inside a longer run ("123456 2024").
          var codes: [Range<String.Index>] = []
          for a in run.groups.indices {
            var total = 0
            for b in a..<run.groups.count {
              total += run.groups[b].count
              if total > 6 { break }
              let r = run.groups[a].range.lowerBound..<run.groups[b].range.upperBound
              if total == 6, standalone(line.text, r) { codes.append(r) }
            }
          }
          guard !codes.isEmpty else { continue }
          let context = mentions[li] || lines.indices.contains { j in
            j != li && mentions[j] && near(line.box, lines[j].box)
          }
          if context { out += codes.map { RedactHit(line: li, range: $0, kind: .code) } }
        }
      }
    }
    return out
  }
}
