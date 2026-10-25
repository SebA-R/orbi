import AppKit
import OrbiDesktopCore

// Renders the overlay off screen and saves PNGs, to compare it with the
// extension's own rendering. Dry run only, and the window sits far off every
// display, so nothing shows on the user's screen and nothing connects:
//
//   ORBI_DESKTOP_DRY_RUN=1 ORBI_DESKTOP_SNAPSHOT=scenes.json \
//     ORBI_DESKTOP_SNAPSHOT_OUT=dir OrbiDesktop
//
// scenes.json: {"width", "height", "scenes": [{"name", "steps": [step]}]},
// each scene on a fresh page. A step is one of
//   {"overlay": params}            an overlay request, as the server sends it
//   {"chunk": [samples, inMs]}     speech audio scheduled, as the player says
//   {"stop": true}                 playback cut (barge-in)
//   {"path": [x0, y0, x1, y1, action]}  a pointer glide, as Input posts it
//   {"press": [x, y]}, {"release": [x, y]}, {"wheel": [x, y]}, {"type": text}
//   {"acting": bool}               an action starts or ends
//   {"frameRect": [x, y, w, h]}    the window the frame goes around (null:
//                                  the whole screen); windows are not tracked
//   {"showCursor": bool}           the menu setting
//   {"js": source}                 page script (a backdrop to compare on)
//   {"eval": source}               page script whose result is logged
//   {"wait": ms}, {"snap": "file.png"}
@MainActor
enum OverlaySnapshots {
  static func run(scenes file: URL, out: URL) async -> Int32 {
    guard let data = try? Data(contentsOf: file), let text = String(data: data, encoding: .utf8),
          let doc = try? JSON.decode(text), let scenes = doc["scenes"]?.array else {
      log("snapshot: cannot read \(file.path)")
      return 1
    }
    let size = NSSize(width: doc["width"]?.double ?? 1280, height: doc["height"]?.double ?? 800)
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    var failed = 0
    for scene in scenes {
      let overlay = Overlay()
      overlay.tracksWindows = false
      let w = overlay.build(frame: NSRect(origin: NSPoint(x: -32000, y: -32000), size: size), offscreen: true)
      w.orderFrontRegardless()
      for _ in 0..<100 where !overlay.isReady { try? await Task.sleep(nanoseconds: 50_000_000) }
      if !overlay.isReady { log("snapshot: page did not load"); failed += 1 }
      for step in scene["steps"]?.array ?? [] {
        failed += await perform(step, overlay, out) ? 0 : 1
      }
      w.orderOut(nil)
      w.close()
    }
    return failed == 0 ? 0 : 1
  }

  private static func perform(_ step: JSON, _ o: Overlay, _ out: URL) async -> Bool {
    let n = { (a: [JSON]?, i: Int) in a?.count ?? 0 > i ? a![i].double ?? 0 : 0 }
    if let p = step["overlay"]?.object {
      do { o.apply(try OverlayUpdate.parse(Params(p))) } catch { log("snapshot: bad overlay step \(error)"); return false }
    } else if let a = step["chunk"]?.array {
      o.speechAudio(samples: Int(n(a, 0)), inSeconds: n(a, 1) / 1000)
    } else if step["stop"] != nil {
      o.stopSpeech()
    } else if let a = step["path"]?.array {
      let to = CGPoint(x: n(a, 2), y: n(a, 3))
      let action = a.count > 4 ? a[4].string ?? "hover" : "hover"
      var rng = Rng(seed: 7)
      for s in planPath(from: Point(x: n(a, 0), y: n(a, 1)), to: Point(x: to.x, y: to.y), rng: &rng) {
        if s.ms > 0 { try? await Task.sleep(nanoseconds: UInt64(s.ms * 1_000_000)) }
        o.cursorMove(CGPoint(x: s.x, y: s.y), to: to, action: action)
      }
    } else if let a = step["press"]?.array {
      o.press(CGPoint(x: n(a, 0), y: n(a, 1)))
    } else if let a = step["release"]?.array {
      o.release(CGPoint(x: n(a, 0), y: n(a, 1)))
    } else if let a = step["wheel"]?.array {
      o.wheel(CGPoint(x: n(a, 0), y: n(a, 1)))
    } else if let t = step["type"]?.string {
      o.typing(t)
    } else if let r = step["frameRect"] {
      let a = r.array
      o.setFrameRect(a == nil ? nil : CGRect(x: n(a, 0), y: n(a, 1), width: n(a, 2), height: n(a, 3)))
    } else if let b = step["showCursor"]?.bool {
      o.setShowCursor(b)
    } else if let b = step["acting"]?.bool {
      if b { o.beginAction() } else { o.endAction() }
    } else if let js = step["js"]?.string {
      o.script(js)
    } else if let js = step["eval"]?.string {
      let r = await o.evaluate(js)
      log("snapshot: eval \(r)")
    } else if let ms = step["wait"]?.double {
      try? await Task.sleep(nanoseconds: UInt64(ms * 1_000_000))
    } else if let name = step["snap"]?.string {
      guard let img = await o.snapshot(), let tiff = img.tiffRepresentation,
            let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
        log("snapshot: no image for \(name)")
        return false
      }
      let file = out.appendingPathComponent((name as NSString).lastPathComponent)
      do { try png.write(to: file) } catch { return false }
      log("snapshot: wrote \(file.path)")
    }
    return true
  }
}
