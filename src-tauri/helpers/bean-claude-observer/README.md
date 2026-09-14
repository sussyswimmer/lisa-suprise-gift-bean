# Accessibility observer sidecar

Build command (macOS):

```bash
cd src-tauri/helpers/bean-claude-observer
swift build -c release
```

Expected output executable:

- `.build/release/bean-claude-observer`

On installation, this binary is expected to be available to Tauri as `helpers/bean-claude-observer`.

If Accessibility is blocked, the helper emits:

```json
{"source":"system","status":"unavailable","timestamp":"..."}
```

To force synthetic events while validating install wiring:

```bash
./.build/release/bean-claude-observer --simulate
```
