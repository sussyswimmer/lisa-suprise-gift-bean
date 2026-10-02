#!/usr/bin/env bash
# Checks a built Bean DMG the way it ships: mounts it, verifies Bean.app's
# signature, and runs the bundled Accessibility helper's self-test.
# Bean bundles only a DMG, so the intermediate Bean.app is gone after a build.
#
# Usage: scripts/verify-dmg.sh <path to .dmg>
set -euo pipefail

dmg=${1:?usage: scripts/verify-dmg.sh <path to .dmg>}
hdiutil verify -quiet "$dmg"
mount=$(mktemp -d)
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$dmg" >/dev/null
trap 'hdiutil detach -quiet "$mount" || hdiutil detach -force -quiet "$mount"' EXIT

app="$mount/Bean.app"
helper="$app/Contents/MacOS/bean-claude-observer"
codesign --verify --deep --strict "$app"
if [[ ! -x $helper ]]; then
  echo "The Accessibility helper is missing from $dmg" >&2
  exit 1
fi
if [[ $(lipo -archs "$helper") == x86_64 && $(uname -m) == arm64 ]] && ! arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "Skipping the Intel helper self-test: Rosetta is not installed."
else
  "$helper" --self-test
fi
