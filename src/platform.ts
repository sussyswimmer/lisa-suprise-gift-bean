// `window.isTauri` is only present when the optional global Tauri API is
// enabled. The module API works without that global, so detect its internal
// bridge instead and keep the production bundle connected to Rust.
export function isBeanDesktop() {
  if (typeof window === "undefined") return false;

  // Tauri's internal object is injected asynchronously in some packaged
  // builds.  The app is already running at a tauri: URL, though, so relying
  // only on that object can prevent the first native status sync and leave
  // Bean showing an old permission warning forever.
  return (
    window.location.protocol === "tauri:" || "__TAURI_INTERNALS__" in window
  );
}

/** The Tauri window this page runs in: "main" for Bean, "settings" for Settings. */
export function currentWindowLabel(): string {
  if (typeof window === "undefined") return "main";
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        metadata?: { currentWindow?: { label?: string } };
      };
    }
  ).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  if (label) return label;
  // A browser preview opens Settings at ?view=settings.
  return new URLSearchParams(window.location.search).get("view") === "settings"
    ? "settings"
    : "main";
}

/** A short chime; `volume` runs from 0 to 100. */
export function playTone(volume = 60) {
  if (typeof AudioContext === "undefined" || volume <= 0) return;
  const context = new AudioContext();
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "triangle";
  osc.frequency.value = 620;
  // 60 matches the original fixed gain of 0.02.
  gain.gain.value = (0.02 * volume) / 60;
  osc.connect(gain).connect(context.destination);
  osc.start();
  osc.onended = () => {
    void context.close();
  };
  osc.stop(context.currentTime + 0.25);
}
