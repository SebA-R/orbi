import AppKit

// Orbi Desktop: a menu-bar helper (no Dock icon) that lets the Orbi server
// see and act on the whole Mac. See desktop/README.md.
MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(Env.dryRun ? .prohibited : .accessory)
  withExtendedLifetime(delegate) { app.run() }
}
