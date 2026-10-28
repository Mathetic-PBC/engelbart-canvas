#!/bin/bash
# Builds mac/build/Engelbart.app from the Swift app package (mac/Engelbart), the Swift counterpart of
# electron-builder.config.cjs's mac section, for this Mac only:
#   - the executable, built with SwiftPM (ENGELBART_CONFIG=debug|release, release by default)
#   - Info.plist: id com.mathetic.engelbart.swift (apart from the Electron app's dev.engelbart.desktop, so macOS keeps
#     their permissions apart), name Engelbart, version 0.1.25, productivity, the folder-usage strings
#   - the icon from build/icon.icns
#   - every SwiftPM resource bundle in Contents/Resources, where EngelbartUI.ResourceBundle finds it (SwiftPM's own
#     Bundle.module looks at the .app's root, which a signed app cannot hold)
#   - Contents/Resources/build.json: { "developer": true } only with ENGELBART_DEVELOPER=1 (test mode; Developer.swift)
#   - an ad-hoc signature (an Apple Silicon Mac runs nothing unsigned); Developer ID signing and notarizing are for a
#     release pipeline, not this script.
# Usage: mac/scripts/bundle.sh            (ENGELBART_DEVELOPER=1 for a developer copy)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$(dirname "$HERE")"
REPO="$(dirname "$MAC")"
CONFIG="${ENGELBART_CONFIG:-release}"
VERSION="0.1.25"
BUNDLE_ID="com.mathetic.engelbart.swift"
APP="$MAC/build/Engelbart.app"

cd "$MAC/Engelbart"
swift build -c "$CONFIG" --product Engelbart
BIN="$(swift build -c "$CONFIG" --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Engelbart" "$APP/Contents/MacOS/Engelbart"

shopt -s nullglob
bundles=("$BIN"/*.bundle)
for bundle in "${bundles[@]}"; do
  cp -R "$bundle" "$APP/Contents/Resources/"
done
shopt -u nullglob

cp "$REPO/build/icon.icns" "$APP/Contents/Resources/Engelbart.icns"

developer=false
if [ "${ENGELBART_DEVELOPER:-}" = "1" ]; then developer=true; fi
printf '{"developer":%s}\n' "$developer" > "$APP/Contents/Resources/build.json"

USAGE="Engelbart’s terminals and agents work in the folders you choose."
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Engelbart</string>
  <key>CFBundleIconFile</key><string>Engelbart</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Engelbart</string>
  <key>CFBundleDisplayName</key><string>Engelbart</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Engelbart</string>
  <key>NSDocumentsFolderUsageDescription</key><string>${USAGE}</string>
  <key>NSDesktopFolderUsageDescription</key><string>${USAGE}</string>
  <key>NSDownloadsFolderUsageDescription</key><string>${USAGE}</string>
  <key>NSRemovableVolumesUsageDescription</key><string>${USAGE}</string>
  <key>NSNetworkVolumesUsageDescription</key><string>${USAGE}</string>
  <key>NSAppleEventsUsageDescription</key><string>Engelbart reads the notes you choose from apps such as Notes.</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"

echo "$APP"
echo "resource bundles: ${#bundles[@]}"
