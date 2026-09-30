# Higgsfield Prompts for Bean

Use these prompts with the approved Bean reference photos. Keep the character **stylized and game-like**, never photorealistic.

## General

- Bean is an original compact apricot toy poodle: caramel curls, oversized dark-brown eyes, black button nose, and floppy ears.
- Use polished 8-bit-inspired pixel art with chunky clean forms, a warm-gold and midnight-blue palette, and subtle pixel texture.
- Keep a small full-body silhouette that reads at 90 px. Preserve the same face, curls, and body proportions across every animation.
- Use a pale or transparent background. No humans, realistic fur, text, logos, or branded characters.
- Make each motion a seamless short loop when the Higgsfield mode supports loops.

## State prompts

### idle — gentle breathing
"Original compact apricot toy poodle game companion, polished 8-bit-inspired pixel art. Bean sits calmly, blinks once, breathes gently, twitches one floppy ear, and gives one tiny tail wag. Warm-gold and midnight-blue palette, pale background, seamless loop. No photorealism, people, text, logos, or branded characters."

### working — typing at the computer
"Original compact apricot toy poodle game companion, polished 8-bit-inspired pixel art. Bean sits at a tiny midnight-blue laptop and alternates both front paws across the keyboard while the screen softly glows. Add a blink, ear twitch, and tiny focused head bob. This means work is in progress, not finished. Warm-gold and midnight-blue palette, pale background, seamless loop. No photorealism, people, text, logos, or branded characters."

### complete — jump celebration
"Original compact apricot toy poodle game companion, polished 8-bit-inspired pixel art. Bean makes one joyful little jump, lands with a soft squash-and-stretch, wags, and releases four tiny pixel confetti squares. Clear completed-task celebration, no words. Warm-gold and midnight-blue palette, pale background. No photorealism, people, text, logos, or branded characters."

### attention-needed — alert bounce
"Original compact apricot toy poodle game companion, polished 8-bit-inspired pixel art. Bean perks both ears, looks up, makes two short alert bounces, and a small pixel exclamation mark appears above the head. This means attention is needed, not completion. Warm-gold and midnight-blue palette, pale background, seamless loop. No photorealism, people, text, logos, or branded characters."

### affection — happy wiggle
"Original compact apricot toy poodle game companion, polished 8-bit-inspired pixel art. Bean smiles, gives a shy side-to-side wiggle, lifts one paw, and shows one tiny warm pixel heart. Warm-gold and midnight-blue palette, pale background, seamless loop. No photorealism, people, text, logos, or branded characters."

### sleepy — nap loop
"Original compact apricot toy poodle game companion, polished 8-bit-inspired pixel art. Bean curls into a cozy nap, breathes slowly, one ear moves, and two small pixel z letters drift upward. Warm-gold and midnight-blue palette, pale background, seamless loop. No photorealism, people, text, logos, or branded characters."

### sound-off — quiet idle
"Original compact apricot toy poodle game companion, polished 8-bit-inspired pixel art. Bean sits in a quiet calm pose, blinks slowly, and makes one gentle tail wag. Warm-gold and midnight-blue palette, pale background, seamless loop. No photorealism, people, text, logos, or branded characters."

## Animated sprite sheets (AutoSprite)

Bean plays sprite sheets frame by frame, so real running, walking, and jumping come from Higgsfield's **AutoSprite** model (`autosprite`). Use `public/bean/generated/idle.png` as the single `image` input (or `working.png` for the typing loop) so every sheet keeps Bean's face, curls, and palette. Set `is_humanoid: false`, `frame_size: 256`, `remove_bg: default`, and `video_tier: turbo` (use `pro` if the legs smear).

| Bean slot | AutoSprite `kind` | `frame_count` | Custom prompt (only for `kind: custom`) |
| --- | --- | --- | --- |
| `run` motion — zoomies and running to the laptop | `run` | 12 | — |
| `walk` motion — trotting around | `walk` | 12 | — |
| `happy` state — completion | `jump` | 16 | — |
| `idle` state | `idle` | 16 | — |
| `thinking` state (from `working.png`) | `custom`, name `typing` | 12 | "Bean alternates both front paws on the tiny laptop keyboard, small focused head bob, seamless loop." |
| `sleepy` state | `custom`, name `nap` | 16 | "Bean lies down curled up and breathes slowly, one ear twitches, seamless loop." |
| `noticed` state | `custom`, name `alert` | 12 | "Bean perks both ears and makes two short alert bounces, seamless loop." |

Download each sheet, then add it:

```bash
npm run add:sprite -- run ~/Downloads/bean-run.png --fps 12 --facing right
npm run add:sprite -- happy ~/Downloads/bean-jump.png --fps 14 --loop false
```

The script copies the sheet to `public/bean/sprites/` and updates `public/bean/manifest.json`. Frames default to a grid of 256 px cells; pass `--frames` and `--columns` when the sheet has empty trailing cells. Use `--facing right` for side-view sheets where Bean looks right, so she is mirrored the correct way while running.
