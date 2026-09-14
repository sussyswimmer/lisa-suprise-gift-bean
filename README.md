# Bean

Bean is a floating macOS companion for Claude Chat and Claude Cowork.

It is packaged with Tauri, React, and TypeScript. Bean does not use Claude API keys and does not store chat data.

## What it does

- stays as a tiny always-on-top desktop companion
- listens to local Claude activity through macOS Accessibility events
- shows a small reaction state: `idle`, `noticed`, `thinking`, `message`, `happy`, `sleepy`, `soundOff`
- gives one celebration per confirmed completion
- supports sound toggle, pause, hide, and quit
- supports local asset pack path for replacement artwork
- stores preferences in local storage only

## Quick run (dev)

```bash
npm install
npm run dev
```

## Build a local mac artifact

On macOS:

```bash
npm install
npm run build
npx tauri build
```

This produces a DMG bundle via Tauri.

## Accessibility requirements

Apple macOS Privacy requires granting Accessibility permission to the app.

- Settings → Privacy & Security → Accessibility
- Add Bean
- Enable input monitoring if the OS prompts for additional trust

Without permission, Bean enters `sleepy/unavailable` and shows that external signals are not being observed.

## Delivery model

- This repo is intended to be a private repository named `bean`.
- No photos are stored in git.
- For release-grade distribution with normal first-run trust behavior, add Apple Developer credentials and enable notarization.

## Verification checklist

- formatting/lint/typecheck/build commands are available:
  - `npm run lint`
  - `npm run test`
  - `npm run typecheck`
  - `npm run build`
  - `npm run tauri:build`
- capture state checks in Chat/Cowork for `working`, `completed`, `attention_needed`, `stopped`, `failed`, `unavailable`
- test minimized and hidden Claude windows
- verify no repeated completion notifications for duplicate events
- verify reduced-motion mode and missing asset fallback behavior

## Repo layout

- `src/` React interface + state machine
- `src-tauri/` Rust backend + Tauri config
- `src-tauri/helpers/bean-claude-observer/` macOS accessibility helper
- `public/bean/` built-in placeholder assets and manifest
- `BEAN_ASSET_GUIDE.md` and `higgsfield-prompts.md` for later artwork generation
