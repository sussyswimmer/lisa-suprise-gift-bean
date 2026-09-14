# Bean

Bean is a draggable macOS companion for Claude Desktop. It uses your existing Claude sign-in; it has no API keys and does not read passwords or chat text.

## Download Bean

**[Open the Bean Releases page](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases)** for every downloadable build.

| Release | Apple Silicon (M1–M4) | Intel Mac |
| --- | --- | --- |
| v0.1.0-test.5 — interaction and observer fix | pending build | pending build |
| [v0.1.0-test.4 — corrected companion](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/tag/v0.1.0-test.4) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.4/Bean_0.1.0_aarch64.dmg) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.4/Bean_0.1.0_x64.dmg) |
| [v0.1.0-test.3 — character-only companion](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/tag/v0.1.0-test.3) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.3/Bean_0.1.0_aarch64.dmg) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.3/Bean_0.1.0_x64.dmg) |
| [v0.1.0-test.2 — animated companion](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/tag/v0.1.0-test.2) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.2/Bean_0.1.0_aarch64.dmg) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.2/Bean_0.1.0_x64.dmg) |
| [v0.1.0-test.1](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/tag/v0.1.0-test.1) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.1/Bean_0.1.0_aarch64.dmg) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.1/Bean_0.1.0_x64.dmg) |

The test builds are unsigned. On first launch, macOS may require Control-clicking Bean and choosing **Open**.

## What it does

- opens with a one-time explanation that it uses the Claude Desktop subscription already signed in on that Mac
- requests macOS Accessibility permission only after that explanation
- keeps Bean draggable from the sprite itself, with no opaque app panel around her
- shows a compact local status bubble above Bean: working, ready, attention needed, or waiting
- runs the bundled macOS Accessibility helper from the installed app bundle
- gives a pixel animation for idle, working, attention, stopped, and completion states
- stores preferences locally only; personal reference photos are outside git

## Claude monitoring

Bean reads only local macOS Accessibility labels exposed by Claude Desktop to determine app state. It does not collect chat text, credentials, session tokens, or send Claude data anywhere.

The live detector is designed for Claude Desktop Chat and Cowork. Claude Code running inside a terminal has no equivalent reliable, transcript-free completion signal available through macOS Accessibility, so this build does not claim terminal/CLI completion notifications.

## Build

```bash
npm install
npm run lint
npm run test
npm run typecheck
npm run build
npx tauri build
```

The GitHub workflow creates unsigned Apple Silicon and Intel DMGs with SHA-256 checksums. A normal signed/notarized gift release still needs Apple Developer credentials.
