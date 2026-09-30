# Bean

Bean is a draggable macOS companion for Claude Desktop. It observes the Claude app you already use; it has no separate Claude login or API keys. Prompt and reply previews stay on your Mac. Bean never reads passwords or session tokens.

## Download Bean

**[Open the Bean Releases page](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases)** for every downloadable build.

| Release | Apple Silicon (M1–M4) | Intel Mac |
| --- | --- | --- |
| [v0.1.0-test.6 — Claude snippets](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/tag/v0.1.0-test.6) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.6/Bean_0.1.0_aarch64.dmg) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.6/Bean_0.1.0_x64.dmg) |
| [v0.1.0-test.5 — draggable Claude Code companion](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/tag/v0.1.0-test.5) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.5/Bean_0.1.0_aarch64.dmg) | [DMG](https://github.com/sussyswimmer/lisa-suprise-gift-bean/releases/download/v0.1.0-test.5/Bean_0.1.0_x64.dmg) |
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
- uses official local Claude Code hooks for sent, complete, failed, stopped, and attention-needed states
- runs the bundled macOS Accessibility helper from the installed app bundle
- gives a pixel animation for idle, working, attention, stopped, and completion states, and plays sprite sheets frame by frame when the asset pack provides them
- runs to her laptop when Claude starts working, and between tasks does zoomies, trots around, chases her tail, stretches, sniffs, peeks, hops, and sips boba
- stores preferences locally only; personal reference photos are outside git

## Claude monitoring

Bean finds the current Claude Desktop host (`com.anthropic.claudefordesktop`) and reads its local macOS Accessibility labels to determine app state. Chat, Cowork, and Code run inside that host and are distinguished from the labels Claude exposes. Bean does not collect credentials or session tokens, and it sends no Claude data anywhere.

Claude Code uses its official local Hooks system. Bean installs local hooks after you choose **Connect** and repairs them when Bean starts. With previews enabled, hooks use the provided prompt, streamed message text, and final reply fields; they do not open transcript files. The local handoff queue is cleared after Bean consumes each batch. Claude Desktop Chat and Cowork use Accessibility and depend on the interface Claude exposes on the destination Mac.

Bean reads Claude's composer area first: the Stop button means Claude is replying, and the Send button means it is ready. A scan that has not reached the composer yet is treated as unknown, not as finished. Desktop Chat keeps syncing while Claude Code is open; an interrupted Claude Code turn (which sends no Stop hook) expires instead of hiding Chat. If the helper exits, Bean restarts it.

Connection checks distinguish denied Accessibility, a closed Claude app, a missing Claude window, and an unreadable chat interface. Test builds are ad-hoc signed, so macOS can keep showing Bean as allowed while denying a newly installed build; **Reset permission** in Bean clears that stale entry so macOS can ask again. Permission alone does not count as a successful Desktop connection. Bean enables Electron's documented [`AXManualAccessibility` attribute](https://www.electronjs.org/docs/latest/tutorial/accessibility#within-third-party-software) on Claude so its Chromium interface can be exposed without enabling VoiceOver.

The helper's `--self-test` checks delivery of the first live Claude Code prompt and completion, and the documented final-reply field. These checks do not establish live Chat/Cowork compatibility; that still requires testing the installed app on a Mac running Claude.

## Build

Requires macOS 14+, Node.js 22.12+ (CI uses 24), Rust, and Xcode command-line tools.

```bash
npm ci
npm run check
npm run build:helper
cargo test --locked --manifest-path src-tauri/Cargo.toml
npx tauri build
```

`tauri dev` and `tauri build` compile the helper from source automatically. To cross-compile the helper, run `npm run build:helper -- x86_64-apple-darwin` (or `aarch64-apple-darwin`). Generated helpers are not committed. Frontend-only preview uses `npm run dev`; native connection and dragging require the desktop app.

Pause, completion sound, and Code preview preferences persist locally. Disabling previews immediately clears the visible snippet and updates the hook configuration. Hook installation preserves unrelated Claude Code commands. The event fields follow the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

The GitHub workflow creates unsigned Apple Silicon and Intel DMGs with SHA-256 checksums. A normal signed/notarized gift release still needs Apple Developer credentials.


