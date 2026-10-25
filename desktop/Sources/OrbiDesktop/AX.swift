import AppKit
import ApplicationServices
import Carbon.HIToolbox
import OrbiDesktopCore

// Reading the screen through Accessibility: the frontmost app, compact
// element snapshots with refs, hit tests, and the frames of every secure
// text field on screen (for screenshot redaction). A secure field's value is
// never read, let alone returned.

struct AXNode {
  let element: AXUIElement
  let pid: pid_t
  let role: String
  let subrole: String?
  let title: String?
  let label: String?
  let value: String?
  let frame: CGRect?
  let enabled: Bool
  let secure: Bool

  var json: JSON { json(ref: nil) }

  func json(ref: String?) -> JSON {
    var o: [String: JSON] = ["role": .string(role), "enabled": .bool(enabled), "secure": .bool(secure)]
    if let ref { o["ref"] = .string(ref) }
    if let subrole, !subrole.isEmpty { o["subrole"] = .string(subrole) }
    if let title, !title.isEmpty { o["title"] = .string(title) }
    if let label, !label.isEmpty { o["label"] = .string(label) }
    if secure { o["value"] = "[hidden]" }
    else if let value, !value.isEmpty { o["value"] = .string(value) }
    if let f = frame {
      o["frame"] = ["x": JSON(f.origin.x.rounded()), "y": JSON(f.origin.y.rounded()),
                    "w": JSON(f.width.rounded()), "h": JSON(f.height.rounded())]
    }
    return .object(o)
  }
}

enum AX {
  static let timeout: Float = 0.5
  static let maxText = 200

  static let interactiveRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox",
    "AXPopUpButton", "AXMenuButton", "AXSlider", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXDisclosureTriangle",
    "AXIncrementor", "AXStepper", "AXColorWell", "AXDateField", "AXTab", "AXSearchField", "AXCell", "AXRow",
    "AXSegmentedControl", "AXDockItem",
  ]
  static let textRoles: Set<String> = ["AXStaticText", "AXHeading", "AXImage"]

  static func isSecure(role: String?, subrole: String?) -> Bool {
    [role, subrole].contains { ($0 ?? "").lowercased().contains("secure") }
  }

  static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
    return v
  }

  static func string(_ el: AXUIElement, _ name: String) -> String? {
    attr(el, name).flatMap(stringify)
  }

  static func stringify(_ v: CFTypeRef) -> String? {
    if let s = v as? String { return clip(s) }
    if let n = v as? NSNumber { return n.stringValue }
    if let u = v as? URL { return clip(u.absoluteString) }
    if let a = v as? NSAttributedString { return clip(a.string) }
    return nil
  }

  static func clip(_ s: String) -> String {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.count > maxText ? String(t.prefix(maxText - 3)) + "..." : t
  }

  static func element(_ v: CFTypeRef?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
  }

  static func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
  }

  static func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AnyObject] ?? []).compactMap { element($0) }
  }

  static func pid(_ el: AXUIElement) -> pid_t? {
    var p: pid_t = 0
    return AXUIElementGetPid(el, &p) == .success ? p : nil
  }

  static func app(_ pid: pid_t) -> AXUIElement {
    let a = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(a, timeout)
    return a
  }

  // One element's facts. The value is only read once the element is known
  // not to be secure.
  static func node(_ el: AXUIElement, pid: pid_t) -> AXNode {
    let role = string(el, kAXRoleAttribute) ?? "AXUnknown"
    let subrole = string(el, kAXSubroleAttribute)
    let secure = isSecure(role: role, subrole: subrole)
    let label = string(el, kAXDescriptionAttribute) ?? string(el, "AXPlaceholderValue") ?? string(el, kAXHelpAttribute)
    let value = secure ? nil : string(el, kAXValueAttribute)
    let enabled = (attr(el, kAXEnabledAttribute) as? Bool) ?? true
    return AXNode(element: el, pid: pid, role: role, subrole: subrole, title: string(el, kAXTitleAttribute),
                  label: label, value: value, frame: frame(el), enabled: enabled, secure: secure)
  }

  static func keep(_ n: AXNode) -> Bool {
    guard let f = n.frame, f.width > 0, f.height > 0, onAnyScreen(f) else { return false }
    if interactiveRoles.contains(n.role) || n.secure { return true }
    if textRoles.contains(n.role) {
      return !(n.value ?? "").isEmpty || !(n.title ?? "").isEmpty || !(n.label ?? "").isEmpty
    }
    return false
  }

  static func onAnyScreen(_ f: CGRect) -> Bool {
    guard let mainH = NSScreen.screens.first?.frame.height else { return true }
    return NSScreen.screens.contains { s in
      // NSScreen frames are bottom-left based; flip to the AX space.
      let r = CGRect(x: s.frame.minX, y: mainH - s.frame.maxY, width: s.frame.width, height: s.frame.height)
      return r.intersects(f)
    }
  }

  // The windows to walk for an app: the focused one first, then the rest.
  static func windows(of app: AXUIElement) -> [AXUIElement] {
    var out: [AXUIElement] = []
    if let f = element(attr(app, kAXFocusedWindowAttribute)) { out.append(f) }
    for w in (attr(app, kAXWindowsAttribute) as? [AnyObject] ?? []).compactMap({ element($0) }) where !out.contains(where: { CFEqual($0, w) }) {
      out.append(w)
    }
    return out
  }

  // Breadth-first over the windows, keeping interactive and labeled text
  // elements, until maxNodes are kept or visitCap visited.
  static func snapshot(pid: pid_t, maxNodes: Int, visitCap: Int = 3000) -> [AXNode] {
    let a = app(pid)
    var queue = windows(of: a)
    var head = 0
    var kept: [AXNode] = []
    while head < queue.count, kept.count < maxNodes, head < visitCap {
      let el = queue[head]
      head += 1
      let n = node(el, pid: pid)
      if keep(n) { kept.append(n) }
      if n.secure { continue } // nothing under a secure field is read
      queue += children(el)
    }
    return kept
  }

  static func hitTest(x: Double, y: Double) -> AXNode? {
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, timeout)
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &el) == .success, let el, let pid = pid(el) else { return nil }
    return node(el, pid: pid)
  }

  static func focusedWindowTitle(pid: pid_t) -> String? {
    guard let w = element(attr(app(pid), kAXFocusedWindowAttribute)) else { return nil }
    return string(w, kAXTitleAttribute)
  }

  static let browsers: Set<String> = [
    "com.google.chrome", "com.google.chrome.beta", "com.google.chrome.dev", "com.google.chrome.canary",
    "com.apple.safari", "com.apple.safaritechnologypreview", "company.thebrowser.browser",
  ]

  // The page URL of a browser's focused window: its web area's AXURL, or
  // failing that the address field's text.
  static func browserURL(pid: pid_t) -> String? {
    guard let w = element(attr(app(pid), kAXFocusedWindowAttribute)) else { return nil }
    var queue = [w]
    var head = 0
    var address: String?
    while head < queue.count, head < 1500 {
      let el = queue[head]
      head += 1
      let role = string(el, kAXRoleAttribute)
      if role == "AXWebArea", let u = attr(el, "AXURL") {
        if let url = u as? URL { return url.absoluteString }
        if let s = u as? String, !s.isEmpty { return s }
      }
      if address == nil, role == "AXTextField",
         let d = (string(el, kAXDescriptionAttribute) ?? string(el, kAXTitleAttribute))?.lowercased(),
         d.contains("address") || d.contains("url") || d.contains("search or enter") {
        address = string(el, kAXValueAttribute)
      }
      if isSecure(role: role, subrole: string(el, kAXSubroleAttribute)) { continue }
      queue += children(el)
    }
    return address
  }

  // The focused element anywhere is a secure field, or macOS has secure
  // keyboard entry on (a password field or Terminal's setting): typing must
  // not go there.
  static func secureInputActive() -> Bool {
    if IsSecureEventInputEnabled() { return true }
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, timeout)
    guard let f = element(attr(sys, kAXFocusedUIElementAttribute)) else { return false }
    return isSecure(role: string(f, kAXRoleAttribute), subrole: string(f, kAXSubroleAttribute))
  }

  enum ScanResult {
    case ok([CGRect])
    case failed // the app's tree could not be read; cover its windows
  }

  // Frames of the secure fields in one app's windows.
  static func secureFrames(pid: pid_t, visitCap: Int = 4000, deadline: Date) -> ScanResult {
    let a = app(pid)
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(a, kAXWindowsAttribute as CFString, &v)
    if err == .cannotComplete || err == .apiDisabled { return .failed }
    var queue = (v as? [AnyObject] ?? []).compactMap { element($0) }
    var head = 0
    var out: [CGRect] = []
    while head < queue.count, head < visitCap {
      if Date() > deadline { return .failed }
      let el = queue[head]
      head += 1
      if isSecure(role: string(el, kAXRoleAttribute), subrole: string(el, kAXSubroleAttribute)) {
        if let f = frame(el) { out.append(f) }
        continue
      }
      queue += children(el)
    }
    return .ok(out)
  }
}
