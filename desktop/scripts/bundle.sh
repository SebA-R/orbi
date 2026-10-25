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
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"
echo "Built $APP"
