# Bean Asset Guide

This project starts with temporary SVG assets in `public/bean/placeholder`.
Replace them later with original Bean artwork in `public/bean/processed` and create a simple asset pack folder with the same filenames:

- `idle.svg`
- `noticed.svg`
- `thinking.svg`
- `message.svg`
- `happy.svg`
- `sleepy.svg`
- `sound-off.svg`

You can import your pack from the app by entering the folder path in **Asset pack path (optional)**.

## Recommended canvas and naming

The pet is expected to sit in a compact floating view around 180 × 246 points. Keep transparent backgrounds where possible.

Preferred export:

- dimensions around `256x256`
- PNG/SVG with no shadow
- alpha channel preserved

## Animated sprite sheets

`public/bean/manifest.json` accepts a still image path or a sprite sheet for every state:

```json
"happy": { "src": "/bean/sprites/happy.png", "frames": 16, "fps": 14, "columns": 4, "loop": false }
```

Optional `motions.run` and `motions.walk` sheets are used while Bean runs zoomies, trots around, or runs to her laptop when Claude starts working. Without them she moves with the still art. Add sheets with `npm run add:sprite` (see `higgsfield-prompts.md`).

## File fallback rules

- Missing files always fall back to `public/bean/manifest.json` references.
- If the manifest path is corrupt, Bean uses placeholder SVGs and continues to run.

## What changed per state

- `idle`: waiting state
- `noticed`: attention required
- `thinking`: active or in progress
- `message`: transient notices and stop/fail
- `happy`: completion celebration
- `sleepy`: unavailable / background waiting
- `sound-off`: muted mode
