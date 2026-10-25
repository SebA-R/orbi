#!/usr/bin/env bash
# Builds Orbi Desktop.app: swift build (release), wrapped with Info.plist
# (LSUIElement, usage strings for Microphone, Accessibility and Screen
# Recording) and signed ad hoc. Output: desktop/build/Orbi Desktop.app
#
#   desktop/scripts/bundle.sh            release build
#   CONFIG=debug desktop/scripts/bundle.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${CONFIG:-release}"
swift build -c "$CONFIG"
BIN="$(swift build -c "$CONFIG" --show-bin-path)/OrbiDesktop"
APP="build/Orbi Desktop.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/OrbiDesktop"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# The overlay page, and the extension's own overlay scripts it runs, unchanged
# (the list is OverlayAssets.files in Sources/OrbiDesktop/Overlay.swift).
OV="$APP/Contents/Resources/overlay"
mkdir -p "$OV/ext"
cp Resources/overlay/index.html Resources/overlay/shim.js Resources/overlay/bridge.js "$OV/"
cp ../extension/content/orb-face.js ../extension/content/subtitles.js ../extension/content/frame.js \
  ../extension/content/cursor.js ../extension/lib/voice/karaoke.js ../extension/lib/voice/chime.js "$OV/ext/"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"
echo "Built $APP"
