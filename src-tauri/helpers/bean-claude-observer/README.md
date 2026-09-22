# Accessibility observer sidecar

From the repository root on macOS, run `npm run build:helper`. This compiles the Swift source to the target-suffixed executable required by Tauri. `tauri dev` and `tauri build` also run this step automatically.

For Intel packaging, use `npm run build:helper -- x86_64-apple-darwin`. Both targets require macOS 14 or later.

Run `src-tauri/helpers/bean-claude-observer-aarch64-apple-darwin --self-test` on Apple Silicon to test queue delivery, completion transitions, and preview privacy without modifying Claude settings or requesting Accessibility access. Substitute the Intel suffix when needed.

`--simulate` emits synthetic working/completed events. `--connection-status` inspects the currently exposed Claude interface without requesting permission. `--request-permission` is the explicit permission prompt used after Connect.

Desktop monitoring emits status only. Code hooks retain session identity in status-only mode; optional previews are limited to 240 characters and consumed through a locked local queue.
