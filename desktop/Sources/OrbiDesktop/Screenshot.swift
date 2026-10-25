import AppKit
import CoreGraphics
import ImageIO
import OrbiDesktopCore
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

// screenshot {maxWidth}: the main display through ScreenCaptureKit, with
// every window of a blocked app (and of the helper itself) left out of the
// capture. Redacted here, before anything is encoded:
//   1. the frame of every secure text field on screen is blacked out; an app
//      whose tree cannot be read in time has all its windows blacked out;
//   2. Vision reads the text, and card numbers (Luhn) and one-time codes
//      near "code"/"verification" are blacked out (OrbiDesktopCore/Redaction).
// Any failure in redaction fails the request; the unredacted image never
// leaves this file.
enum Screenshot {
  struct Shot {
    let png: Data
    let width: Int
    let height: Int
    let scale: Double
    let excluded: [String] // bundle ids left out of the capture
  }

  // OCR and redaction run at up to this width, before scaling down.
  static let workWidth = 3072

  @MainActor
  static func capture(maxWidth: Int, blocklist: Blocklist, exclude: [String]) async throws -> Shot {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      throw ProtoError(.noPermission, "screen capture unavailable: \(error.localizedDescription)")
    }
    let mainID = CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
      throw ProtoError(.internalError, "no display")
    }
    let me = getpid()
    var extra = Blocklist()
    extra.setServerEntries(exclude)
    let excluded = content.applications.filter {
      $0.processID == me || blocklist.isBlocked($0.bundleIdentifier) || extra.isBlocked($0.bundleIdentifier)
    }
    let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
    let points = CGDisplayBounds(display.displayID)
    let native = CGDisplayCopyDisplayMode(display.displayID).map { Double($0.pixelWidth) } ?? 0
    let workW = Int(min(native > 0 ? native : points.width * 2, Double(workWidth)))
    let workH = Int((Double(workW) * points.height / points.width).rounded())
    let config = SCStreamConfiguration()
    config.width = workW
    config.height = workH
    config.showsCursor = false
    config.capturesAudio = false

    // Secure fields are found before and after the capture and both are
    // covered, so a window that moved in between is still covered where
    // the image shows it.
    let excludedPids = Set(excluded.map(\.processID))
    let before = secureRegions(display: points, skip: excludedPids)

    let raw: CGImage
    do {
      raw = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    } catch {
      throw ProtoError(.internalError, "capture failed: \(error.localizedDescription)")
    }

    let secure = before + secureRegions(display: points, skip: excludedPids)

    let px = Double(raw.width) / points.width
    let redacted = try await Task.detached(priority: .userInitiated) {
      try redact(raw, secureInPoints: secure, pointsOrigin: points.origin, pxPerPoint: px)
    }.value

    let outW = min(maxWidth, redacted.width)
    let outH = Int((Double(outW) * Double(redacted.height) / Double(redacted.width)).rounded())
    guard let out = scaled(redacted, width: outW, height: outH), let png = encodePNG(out) else {
      throw ProtoError(.internalError, "encoding failed")
    }
    // Every id asked for counts as excluded (one that is not running has no
    // windows to show), plus the running apps actually left out.
    let ids = Set(exclude + excluded.compactMap(\.bundleIdentifier).filter { $0 != Bundle.main.bundleIdentifier })
    return Shot(png: png, width: outW, height: outH, scale: Double(outW) / points.width, excluded: ids.sorted())
  }

  // Frames (global points) to black out for secure fields: each field, or
  // whole windows of an app that could not be scanned.
  @MainActor
  static func secureRegions(display: CGRect, skip: Set<pid_t>) -> [CGRect] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] else { return [display] } // cannot tell what is on screen: cover it all
    var windowsByPid: [pid_t: [CGRect]] = [:]
    for w in list {
      guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, !skip.contains(pid),
            let b = w[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: b), rect.intersects(display),
            (w[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
      windowsByPid[pid, default: []].append(rect)
    }
    let deadline = Date().addingTimeInterval(2.0)
    var out: [CGRect] = []
    for (pid, rects) in windowsByPid {
      // The Window Server and the Dock draw no text fields.
      if let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == "com.apple.dock" { continue }
      if NSRunningApplication(processIdentifier: pid) == nil, rects.allSatisfy({ $0.height <= 40 }) { continue }
      switch AX.secureFrames(pid: pid, deadline: deadline) {
      case .ok(let frames): out += frames
      case .failed: out += rects
      }
    }
    return out
  }

  static func redact(_ img: CGImage, secureInPoints: [CGRect], pointsOrigin: CGPoint, pxPerPoint: Double) throws -> CGImage {
    let w = img.width, h = img.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
      throw ProtoError(.internalError, "redaction failed: no context")
    }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    // CGContext is y-up; image boxes below are y-down.
    func fill(_ r: CGRect) {
      ctx.fill(CGRect(x: r.minX, y: Double(h) - r.maxY, width: r.width, height: r.height))
    }
    for f in secureInPoints {
      let r = CGRect(x: (f.minX - pointsOrigin.x) * pxPerPoint, y: (f.minY - pointsOrigin.y) * pxPerPoint,
                     width: f.width * pxPerPoint, height: f.height * pxPerPoint)
      fill(r.insetBy(dx: -4, dy: -4))
    }
    for r in try sensitiveTextBoxes(img) { fill(r.insetBy(dx: -6, dy: -4)) }
    guard let out = ctx.makeImage() else { throw ProtoError(.internalError, "redaction failed: no image") }
    return out
  }

  // Pixel boxes (y-down) of card numbers and one-time codes. Reads the top
  // three candidates of every line, so a misread digit in the first one does
  // not hide a number the others got right.
  static func sensitiveTextBoxes(_ img: CGImage) throws -> [CGRect] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.minimumTextHeight = 0.006 // small print too, relative to the image height
    do {
      try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    } catch {
      throw ProtoError(.internalError, "redaction failed: text recognition error")
    }
    let W = Double(img.width), H = Double(img.height)
    func toPixels(_ n: CGRect) -> CGRect {
      CGRect(x: n.minX * W, y: (1 - n.maxY) * H, width: n.width * W, height: n.height * H)
    }
    var lines: [TextLine] = []
    var sources: [(VNRecognizedText, CGRect)] = []
    for obs in req.results ?? [] {
      let box = toPixels(obs.boundingBox)
      for cand in obs.topCandidates(3) {
        lines.append(TextLine(text: cand.string, box: Box(x: box.minX, y: box.minY, w: box.width, h: box.height)))
        sources.append((cand, box))
      }
    }
    var out: [CGRect] = []
    for hit in Redaction.hits(in: lines) {
      let (cand, lineBox) = sources[hit.line]
      // No box for the digits: cover the whole line.
      if let r = try? cand.boundingBox(for: hit.range)?.boundingBox, r.width > 0, r.height > 0 {
        out.append(toPixels(r))
      } else {
        out.append(lineBox)
      }
    }
    return out
  }

  static func scaled(_ img: CGImage, width: Int, height: Int) -> CGImage? {
    if width == img.width && height == img.height { return img }
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
    return ctx.makeImage()
  }

  static func encodePNG(_ img: CGImage) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, img, nil)
    return CGImageDestinationFinalize(dest) ? data as Data : nil
  }
}
