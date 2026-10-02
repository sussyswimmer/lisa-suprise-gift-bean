#!/usr/bin/env bash
# Builds Bean's Apple Silicon and Intel DMGs on a Mac, checks them, and
# publishes them as a GitHub pre-release. Use it while GitHub Actions cannot
# run macOS jobs; otherwise pushing a v* tag publishes the same release.
#
#   scripts/release-mac.sh v0.1.0-test.22
#
# Needs Xcode command-line tools, Rust (rustup), Node.js 22.12+, and a signed-in
# GitHub CLI (`gh auth login`). Notes come from release-notes/<tag>.md, whose
# first line is the release title.
set -euo pipefail

tag=${1:?usage: scripts/release-mac.sh <tag>}
cd "$(dirname "$0")/.."

[[ "$(uname -s)" == Darwin ]] || { echo "Bean's DMGs can only be built on macOS." >&2; exit 1; }
for tool in node npm cargo rustup swiftc gh shasum hdiutil codesign; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
gh auth status >/dev/null
[[ -z "$(git status --porcelain)" ]] || { echo "Commit or stash local changes first." >&2; exit 1; }
commit=$(git rev-parse HEAD)
git fetch -q origin
[[ -n "$(git branch -r --contains "$commit")" ]] || { echo "Push $commit to GitHub before releasing it." >&2; exit 1; }
! gh release view "$tag" >/dev/null 2>&1 || { echo "Release $tag already exists." >&2; exit 1; }

notes="release-notes/$tag.md"
title="Bean $tag"
body=$(mktemp)
if [[ -f "$notes" ]]; then
  title=$(sed -n '1s/^# *//p' "$notes")
  tail -n +2 "$notes" > "$body"
fi

targets=(aarch64-apple-darwin x86_64-apple-darwin)
rustup target add "${targets[@]}"
npm ci
npm run check
npm run build:helper
cargo test --locked --manifest-path src-tauri/Cargo.toml

out=$(mktemp -d)
for target in "${targets[@]}"; do
  npm run build:helper -- "$target"
  npx tauri build --target "$target"
  for dmg in "src-tauri/target/$target/release/bundle"/dmg/*.dmg; do
    scripts/verify-dmg.sh "$dmg"
    cp "$dmg" "$out/"
  done
done
(cd "$out" && shasum -a 256 -- *.dmg > SHA256SUMS.txt)

gh release create "$tag" "$out"/*.dmg "$out/SHA256SUMS.txt" \
  --target "$commit" --prerelease --title "$title" --notes-file "$body"
echo "Published $(gh release view "$tag" --json url -q .url)"
