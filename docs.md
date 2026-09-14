# Installation notes for Bean

## Test build (unsigned) `.dmg`

GitHub Actions generates test DMGs in `build` workflow artifacts:

- `bean-aarch64-apple-darwin-dmg`
- `bean-x86_64-apple-darwin-dmg`

Each includes `sha256-<target>.txt`.

## First run

1. Open the `.dmg`.
2. Copy Bean to `/Applications`.
3. On first launch, grant Accessibility access:
   - Settings → Privacy & Security → Accessibility
   - Add Bean
4. Launch and pin to desired position.

## Apple-signed release expectation

Current build is a test bundle only (no notarization).

To ship a normal distribution:

- Provide Apple Developer ID credentials
- Enable notarization in CI
- Set up the installer profile to show verified app trust behavior

## Failure mode

- If observation does not start, Bean stays in `sleepy/unavailable`.
- Keep the app list small and avoid minimizing system-wide; helper is best-effort and must be validated on your development Mac.
