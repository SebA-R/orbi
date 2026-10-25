import Foundation

// Watchable pace, ported from extension/background/humanize.js: the pointer
// travels a gentle minimum-jerk curve from where it is, sometimes overshoots
// and corrects, rests a beat, then presses; text goes in a key at a time
// with a typist's rhythm; a scroll glides in a few eased wheel steps.
//
// Pure: every planner takes a seeded random source and returns plain data;
// the app plays it with CGEvent. A plan changes only how and when, never
// what: a path starts exactly at `from` and ends exactly on `to`, typing
// keeps every character, and wheel steps add up to the scroll asked for.

public struct Rng {
  // splitmix32: tiny, seedable, good enough for timing jitter (not crypto).
  private var s: UInt32
  public init(seed: UInt32 = UInt32.random(in: .min ... .max)) { s = seed }

  public mutating func next() -> Double {
    s = s &+ 0x9e37_79b9
    var z = s
    z = (z ^ (z >> 16)) &* 0x85eb_ca6b
    z = (z ^ (z >> 13)) &* 0xc2b2_ae35
    return Double(z ^ (z >> 16)) / 4_294_967_296.0
  }

  public mutating func between(_ lo: Double, _ hi: Double) -> Double { lo + next() * (hi - lo) }
  public mutating func chance(_ p: Double) -> Bool { next() < p }

  public mutating func normal() -> Double {
    let u = 1 - next() // keeps log away from 0
    return (-2 * log(u)).squareRoot() * cos(2 * .pi * next())
  }

  // Right-skewed around a median: human delays have a floor and a tail.
  public mutating func skewed(_ median: Double, _ lo: Double, _ hi: Double, spread: Double = 0.3) -> Double {
    clamp(median * exp(normal() * spread), lo, hi)
  }
}

public func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }

public struct Point: Equatable, Sendable {
  public var x: Double, y: Double
  public init(x: Double, y: Double) { self.x = x; self.y = y }
}

// A pointer sample: where to be, after waiting ms.
public struct PathStep: Equatable, Sendable {
  public var x: Double, y: Double, ms: Double
  public init(x: Double, y: Double, ms: Double) { self.x = x; self.y = y; self.ms = ms }
}

public enum Pace {
  public static let moveMinMs = 240.0
  public static let moveMaxMs = 700.0
  public static let dwellMs = (110.0, 240.0)
  public static let holdMs = (55.0, 120.0)
  public static let frameMs = 16.0

  public static let gapMs = 82.0
  public static let gapRange = (45.0, 230.0)
  public static let keyHoldMs = (28.0, 70.0)
  public static let typeBudgetMs = 5_000.0
  public static let fastGapMs = 22.0

  public static let scrollStepPx = 110.0
  public static let scrollMinSteps = 3
  public static let scrollMaxSteps = 10
  public static let scrollStepMs = (28.0, 48.0)
}

// Minimum-jerk profile: starts and ends at rest, fastest in the middle.
public func minJerk(_ u: Double) -> Double { u * u * u * (10 + u * (-15 + 6 * u)) }

private func bezier(_ p0: Point, _ p1: Point, _ p2: Point, _ p3: Point, _ u: Double) -> Point {
  let v = 1 - u
  let a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u
  return Point(x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y)
}

// Travel time grows with the log of distance over target size (Fitts).
public func travelMs(_ d: Double, size: Double?, rng: inout Rng, min lo: Double = Pace.moveMinMs, max hi: Double = Pace.moveMaxMs) -> Double {
  let w = clamp(size ?? 30, 10, 300)
  let base = 150 + 95 * log2(1 + d / w)
  return (clamp(base * rng.skewed(1, 0.8, 1.25, spread: 0.12), lo, hi)).rounded()
}

public func planPath(from: Point, to: Point, rng: inout Rng, size: Double? = nil, ms: Double? = nil,
                     min lo: Double = Pace.moveMinMs, max hi: Double = Pace.moveMaxMs) -> [PathStep] {
  let start = PathStep(x: from.x, y: from.y, ms: 0)
  let d = hypot(to.x - from.x, to.y - from.y)
  if d == 0 { return [start] }
  if d < 2 { return [start, PathStep(x: to.x, y: to.y, ms: Pace.frameMs)] }
  let total = ms ?? travelMs(d, size: size, rng: &rng, min: lo, max: hi)
  let dx = (to.x - from.x) / d, dy = (to.y - from.y) / d
  // Normal to the line: the curve bows to one side, more for longer moves.
  let nx = -dy, ny = dx
  let bow = clamp(d * rng.between(0.06, 0.18), 3, 90) * (rng.chance(0.5) ? 1 : -1)

  // A long move sometimes runs a little past the target and comes back.
  let overshoot = d > 260 && rng.chance(0.3) ? rng.between(6, 18) : 0
  let end = overshoot > 0 ? Point(x: to.x + dx * overshoot, y: to.y + dy * overshoot) : to
  let c1 = Point(x: from.x + (end.x - from.x) * 0.3 + nx * bow, y: from.y + (end.y - from.y) * 0.3 + ny * bow)
  let c2 = Point(x: from.x + (end.x - from.x) * 0.72 + nx * bow * 0.55, y: from.y + (end.y - from.y) * 0.72 + ny * bow * 0.55)

  let mainMs = overshoot > 0 ? total * 0.82 : total
  let n = max(4, Int((mainMs / Pace.frameMs).rounded()))
  let frame = max(1, (mainMs / Double(n)).rounded())
  var out = [start]
  for i in 1...n {
    let u = Double(i) / Double(n)
    let p = bezier(from, c1, c2, end, minJerk(u))
    // A slight tremor, fading out as the hand settles.
    let shake = 0.7 * (1 - u)
    out.append(PathStep(x: (p.x + rng.normal() * shake).rounded(), y: (p.y + rng.normal() * shake).rounded(), ms: frame))
  }
  if overshoot > 0 {
    let back = max(2, Int(((total - mainMs) / Pace.frameMs).rounded()))
    for i in 1...back {
      let u = minJerk(Double(i) / Double(back))
      // The correction is its own small movement, after a short reaction.
      let wait = i == 1 ? rng.between(50, 110).rounded() : Pace.frameMs
      out.append(PathStep(x: (end.x + (to.x - end.x) * u).rounded(), y: (end.y + (to.y - end.y) * u).rounded(), ms: wait))
    }
  }
  // The end is the target itself, never a rounded or shaken copy of it.
  out[out.count - 1].x = to.x
  out[out.count - 1].y = to.y
  return out
}

public struct ClickPlan: Sendable {
  public let path: [PathStep]
  public let dwellMs: Double
  public let holdMs: Double
}

public func planClick(from: Point, to: Point, rng: inout Rng, size: Double? = nil) -> ClickPlan {
  let path = planPath(from: from, to: to, rng: &rng, size: size)
  let dwell = rng.skewed(150, Pace.dwellMs.0, Pace.dwellMs.1).rounded()
  let hold = rng.skewed(80, Pace.holdMs.0, Pace.holdMs.1, spread: 0.25).rounded()
  return ClickPlan(path: path, dwellMs: dwell, holdMs: hold)
}

public struct KeyStep: Equatable, Sendable {
  public let ch: Character
  public var gapMs: Double // wait before this character (0 for the first)
  public var holdMs: Double
}

// Short bursts inside words, a longer gap after a space, more after
// punctuation, the odd pause to think; long text is squeezed toward the
// budget, down to fastGapMs a key on average.
public func planTyping(_ text: String, rng: inout Rng, budgetMs: Double = Pace.typeBudgetMs) -> [KeyStep] {
  let chars = Array(text)
  guard !chars.isEmpty else { return [] }
  var out: [KeyStep] = []
  var burst = 0
  for (i, ch) in chars.enumerated() {
    var gap = 0.0
    if i > 0 {
      let prev = chars[i - 1]
      var median = Pace.gapMs
      if prev == " " { median *= 1.3 }
      else if ".,;:!?".contains(prev) { median *= 1.6 }
      if burst > 0 { median *= 0.72; burst -= 1 }
      else if (ch.isLetter || ch.isNumber || ch == "_") && rng.chance(0.12) { burst = 2 + Int(rng.next() * 4) }
      gap = rng.skewed(median, Pace.gapRange.0, Pace.gapRange.1, spread: 0.28)
      if rng.chance(0.03) { gap += rng.between(150, 350) }
    }
    out.append(KeyStep(ch: ch, gapMs: gap, holdMs: rng.skewed(45, Pace.keyHoldMs.0, Pace.keyHoldMs.1, spread: 0.22).rounded()))
  }
  let total = out.reduce(0) { $0 + $1.gapMs }
  let target = max(budgetMs, Double(chars.count - 1) * Pace.fastGapMs)
  let squeeze = total > target ? target / total : 1
  for i in out.indices { out[i].gapMs = squeeze < 1 ? (out[i].gapMs * squeeze).rounded(.down) : out[i].gapMs.rounded() }
  // The key comes up before the next one goes down.
  for i in 0..<(out.count - 1) { out[i].holdMs = max(1, min(out[i].holdMs, (out[i + 1].gapMs * 0.6).rounded())) }
  return out
}

public struct ScrollStep: Equatable, Sendable {
  public let dx: Int, dy: Int, ms: Double
}

// Eased wheel steps whose integer deltas add up exactly to (dx, dy).
public func planScroll(dx: Int, dy: Int, rng: inout Rng) -> [ScrollStep] {
  let len = hypot(Double(dx), Double(dy))
  guard len > 0 else { return [] }
  let n = Int(clamp((len / Pace.scrollStepPx).rounded(), Double(Pace.scrollMinSteps), Double(Pace.scrollMaxSteps)))
  let w = (0..<n).map { 1 - pow((Double($0) + 0.5) / Double(n), 2) * 0.75 }
  let sum = w.reduce(0, +)
  func split(_ total: Int) -> [Int] {
    var parts: [Int] = []
    var used = 0
    var acc = 0.0
    for i in 0..<n {
      acc += Double(total) * w[i] / sum
      let v = i == n - 1 ? total - used : Int(acc.rounded()) - used
      parts.append(v)
      used += v
    }
    return parts
  }
  let xs = split(dx), ys = split(dy)
  return (0..<n).map { i in ScrollStep(dx: xs[i], dy: ys[i], ms: i == 0 ? 0 : rng.between(Pace.scrollStepMs.0, Pace.scrollStepMs.1).rounded()) }
}
