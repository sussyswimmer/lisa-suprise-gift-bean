import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import BeanCompanion from "./components/BeanCompanion";
import BeanMark from "./components/BeanMark";
import ControlPanel from "./components/ControlPanel";
import WelcomeDialog from "./components/WelcomeDialog";
import {
  BeanManifest,
  BeanAssetState,
  ClaudeEvent,
  claudeEventSchema,
} from "./types";
import {
  connectionMessage,
  initialState,
  nextStateFromEvent,
  reducer,
} from "./state";
import {
  DEFAULT_ASSET_PACK,
  loadManifest,
  normalizeStatusForAsset,
  preloadAssets,
} from "./beanAssets";

const PREFS_KEY = "bean.preferences.v1";

// `window.isTauri` is only present when the optional global Tauri API is
// enabled. The module API works without that global, so detect its internal
// bridge instead and keep the production bundle connected to Rust.
function isBeanDesktop() {
  if (typeof window === "undefined") return false;

  // Tauri's internal object is injected asynchronously in some packaged
  // builds.  The app is already running at a tauri: URL, though, so relying
  // only on that object can prevent the first native status sync and leave
  // Bean showing an old permission warning forever.
  return (
    window.location.protocol === "tauri:" || "__TAURI_INTERNALS__" in window
  );
}

function playTone() {
  if (typeof AudioContext === "undefined") return;
  const context = new AudioContext();
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "triangle";
  osc.frequency.value = 620;
  gain.gain.value = 0.02;
  osc.connect(gain).connect(context.destination);
  osc.start();
  osc.onended = () => {
    void context.close();
  };
  osc.stop(context.currentTime + 0.25);
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (fallback) => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(PREFS_KEY) ?? "null",
      );
      if (saved && typeof saved === "object" && "preferences" in saved) {
        return reducer(fallback, {
          type: "loadPrefs",
          prefs: saved.preferences,
        });
      }
    } catch {
      /* Storage may be unavailable or contain a damaged preference file. */
    }
    return fallback;
  });
  const stateRef = useRef(state);
  const [manifest, setManifest] = useState<BeanManifest>(DEFAULT_ASSET_PACK);
  const [assetPackPath, setAssetPackPath] = useState("");
  const showContent = state.preferences.showContent;
  const setShowContent = (value: boolean) =>
    dispatch({ type: "setShowContent", value });
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [accessMessage, setAccessMessage] = useState("");
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  const connectionRequested = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    void loadManifest().then((nextManifest) => {
      const loaded = nextManifest ?? DEFAULT_ASSET_PACK;
      setManifest(loaded);
      preloadAssets(loaded);
    });
    if (isBeanDesktop()) {
      void invoke<string | null>("get_asset_pack_path", {})
        .then((saved) => {
          if (typeof saved === "string" && saved.length > 0)
            setAssetPackPath(saved);
        })
        .catch((error) => setAccessMessage(String(error)));
    }
  }, []);

  useEffect(() => {
    if (!isBeanDesktop()) return;
    void invoke("set_window_mode", {
      compact: state.preferences.welcomeShown,
    }).catch((error) => setAccessMessage(String(error)));
  }, [state.preferences.welcomeShown]);
  useEffect(() => {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          version: 1,
          preferences: state.preferences,
          note: state.preferences.currentNote,
          manualMessage: state.preferences.manualMessage,
        }),
      );
    } catch {
      setAccessMessage("Preferences could not be saved on this device.");
    }
  }, [state.preferences]);

  const applyObserverEvent = useCallback((input: unknown) => {
    const parsed = claudeEventSchema.safeParse(input);
    if (!parsed.success) return;
    const payload = parsed.data;
    const current = stateRef.current;

    const next = nextStateFromEvent(payload, current);
    stateRef.current = next;
    dispatch({ type: "claudeEvent", event: payload });
    if (connectionRequested.current) {
      if (payload.status !== "unavailable" && payload.source !== "system") {
        connectionRequested.current = false;
        setConnectionError("");
        dispatch({ type: "setWelcomeShown" });
      } else if (payload.status === "unavailable") {
        setConnectionError(connectionMessage(payload));
      }
    }
    if (
      payload.status === "completed" &&
      next.preferences.lastEventKey !== current.preferences.lastEventKey
    ) {
      if (next.preferences.soundEnabled && !next.muted) playTone();
    }
  }, []);

  useEffect(() => {
    if (!isBeanDesktop()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<ClaudeEvent>("bean-claude-event", (event) => {
      if (!active) return;
      applyObserverEvent(event.payload);
    })
      .then((remove) => {
        if (active) unlisten = remove;
        else remove();
      })
      .catch((error) => setAccessMessage(String(error)));

    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyObserverEvent]);

  useEffect(() => {
    const receiveNativeStatus = (event: Event) => {
      const payload = (event as CustomEvent<ClaudeEvent>).detail;
      applyObserverEvent(payload);
    };
    window.addEventListener("bean-observer-status", receiveNativeStatus);
    return () =>
      window.removeEventListener("bean-observer-status", receiveNativeStatus);
  }, [applyObserverEvent]);

  useEffect(() => {
    if (!isBeanDesktop() || !state.preferences.welcomeShown) return;
    let active = true;
    const syncLatestObserverStatus = async () => {
      try {
        const latest = await invoke<ClaudeEvent | null>("get_observer_status");
        if (active && latest) applyObserverEvent(latest);
      } catch {
        // Native events are the primary path. This covers the short startup
        // window where the observer emitted before React subscribed.
      }
    };
    void syncLatestObserverStatus();
    const intervalId = window.setInterval(() => {
      void syncLatestObserverStatus();
    }, 1_500);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [applyObserverEvent, state.preferences.welcomeShown]);

  useEffect(() => {
    if (!isBeanDesktop() || !state.preferences.welcomeShown) return;
    void invoke(state.paused ? "stop_observer" : "start_observer").catch(
      (error) => {
        setAccessMessage(String(error));
      },
    );
  }, [state.preferences.welcomeShown, state.paused]);

  useEffect(() => {
    if (!isBeanDesktop() || !state.preferences.welcomeShown) return;
    void invoke("install_claude_code_hooks", {
      includeContent: showContent,
    }).catch((error) =>
      setAccessMessage(
        `Claude Code hooks could not be installed: ${String(error)}`,
      ),
    );
  }, [state.preferences.welcomeShown, showContent]);

  const mappedAsset = useMemo<BeanAssetState>(() => {
    if (!assetPackPath) return manifest.states;
    // Convert each full file path; appending to an already converted folder
    // URL mixes encoded and unencoded separators.
    const folder = assetPackPath.replace(/\/+$/, "");
    const file = (name: string) => convertFileSrc(`${folder}/${name}`);
    return {
      idle: file("idle.svg"),
      noticed: file("noticed.svg"),
      thinking: file("thinking.svg"),
      message: file("message.svg"),
      happy: file("happy.svg"),
      sleepy: file("sleepy.svg"),
      soundOff: file("sound-off.svg"),
    };
  }, [manifest, assetPackPath]);

  const handleDrag = async () => {
    if (!isBeanDesktop()) return;
    await invoke("drag_window").catch((error) =>
      setAccessMessage(String(error)),
    );
  };

  const connectClaude = async () => {
    if (!isBeanDesktop()) {
      setConnectionError("Connect is available in the Bean desktop app.");
      return;
    }
    setConnecting(true);
    setConnectionError("");
    connectionRequested.current = true;
    try {
      try {
        await invoke("install_claude_code_hooks", {
          includeContent: showContent,
        });
      } catch (error) {
        setAccessMessage(
          `Claude Code hooks could not be installed: ${String(error)}`,
        );
      }
      await invoke("start_observer");
      const accessibilityGranted = await invoke<boolean>(
        "request_accessibility_permission",
      );
      setPermissionBlocked(!accessibilityGranted);
      if (!accessibilityGranted) {
        throw new Error(
          "Allow Bean in System Settings → Privacy & Security → Accessibility, then choose Connect again.",
        );
      }
      const observed = await invoke<ClaudeEvent>("get_connection_status");
      if (observed.status === "unavailable") {
        setConnectionError(connectionMessage(observed));
        return;
      }
      connectionRequested.current = false;
      dispatch({ type: "setWelcomeShown" });
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setConnecting(false);
    }
  };

  const toggleMonitoring = () => {
    const nextPaused = !state.paused;
    dispatch({ type: "setPaused", paused: nextPaused });
    setAccessMessage(
      nextPaused
        ? "Monitoring paused until you resume it."
        : "Bean is watching Claude again.",
    );
  };

  const checkAccessibility = async () => {
    if (!isBeanDesktop()) {
      setAccessMessage(
        "Accessibility checks are available in the Bean desktop app.",
      );
      return;
    }

    setCheckingAccess(true);
    setAccessMessage("");
    try {
      const granted = await invoke<boolean>("request_accessibility_permission");
      if (!granted) {
        dispatch({
          type: "setUnavailable",
          unavailable: true,
          reason: "permission_denied",
        });
        setAccessMessage(
          "Turn on Bean in System Settings → Accessibility, then check again.",
        );
        return;
      }
      if (!state.paused) await invoke("start_observer", {});
      await invoke("install_claude_code_hooks", {
        includeContent: showContent,
      });
      const observed = await invoke<ClaudeEvent>("get_connection_status");
      dispatch({ type: "claudeEvent", event: observed });
      setAccessMessage(connectionMessage(observed));
    } catch (error) {
      dispatch({ type: "setUnavailable", unavailable: true });
      setAccessMessage(
        error instanceof Error
          ? error.message
          : "Bean could not verify Accessibility.",
      );
    } finally {
      setCheckingAccess(false);
    }
  };

  const resetAccessibility = async (report: (message: string) => void) => {
    if (!isBeanDesktop()) return;
    setCheckingAccess(true);
    report("");
    try {
      const granted = await invoke<boolean>("reset_accessibility_permission");
      setPermissionBlocked(!granted);
      if (granted && state.preferences.welcomeShown && !state.paused) {
        await invoke("start_observer");
      }
      report(
        granted
          ? "Accessibility is working again. Bean is reconnecting to Claude."
          : "Bean's old permission was cleared. Turn Bean on in System Settings → Privacy & Security → Accessibility, then connect again.",
      );
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingAccess(false);
    }
  };

  const currentAsset = mappedAsset[normalizeStatusForAsset(state.beanState)];

  return (
    <div
      className={`app-shell${state.preferences.welcomeShown ? "" : " app-welcome"}`}
    >
      {state.preferences.welcomeShown ? (
        <main className="shell-content">
          <header className="bean-topbar">
            <div className="bean-brand" aria-label="Bean companion">
              <BeanMark size={24} />
              <span>Bean</span>
            </div>
            <span
              className={`topbar-presence${state.unavailable ? " is-warning" : state.paused ? " is-muted" : ""}`}
            >
              {state.unavailable
                ? "Waiting"
                : state.paused
                  ? "Paused"
                  : "Watching"}
            </span>
            <button
              className={`settings-trigger${settingsOpen ? " is-open" : ""}`}
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-label={
                settingsOpen ? "Close Bean settings" : "Open Bean settings"
              }
              aria-expanded={settingsOpen}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9.7 3.3L10.3 2H13.7L14.3 3.3L16 4L17.4 3.5L19.8 5.9L19.2 7.4L20 9.1L21.4 9.7V13.1L20 13.7L19.2 15.4L19.8 16.9L17.4 19.3L16 18.8L14.3 19.5L13.7 20.8H10.3L9.7 19.5L8 18.8L6.6 19.3L4.2 16.9L4.8 15.4L4 13.7L2.6 13.1V9.7L4 9.1L4.8 7.4L4.2 5.9L6.6 3.5L8 4L9.7 3.3Z"
                  stroke="currentColor"
                  strokeWidth="1.65"
                  strokeLinejoin="round"
                />
                <circle
                  cx="12"
                  cy="11.4"
                  r="3.1"
                  stroke="currentColor"
                  strokeWidth="1.65"
                />
              </svg>
              <span>Settings</span>
            </button>
          </header>
          <BeanCompanion
            state={state.beanState}
            statusText={state.statusText}
            source={state.source}
            session={state.session}
            preview={showContent ? state.preview : null}
            asset={currentAsset}
            restAsset={mappedAsset.idle}
            motions={assetPackPath ? {} : manifest.motions}
            onDragStart={handleDrag}
          />
          <ControlPanel
            open={settingsOpen}
            unavailable={state.unavailable}
            permissionDenied={
              state.unavailableReason === "permission_denied" ||
              permissionBlocked
            }
            paused={state.paused}
            soundEnabled={state.preferences.soundEnabled}
            showContent={showContent}
            checkingAccess={checkingAccess}
            accessMessage={accessMessage}
            statusText={state.statusText}
            onClose={() => setSettingsOpen(false)}
            onPauseToggle={() => void toggleMonitoring()}
            onSoundToggle={() =>
              dispatch({
                type: "setSound",
                soundEnabled: !state.preferences.soundEnabled,
              })
            }
            onShowContentChange={setShowContent}
            onCheckAccess={() => void checkAccessibility()}
            onResetAccess={() => void resetAccessibility(setAccessMessage)}
          />
        </main>
      ) : (
        <WelcomeDialog
          showContent={showContent}
          connecting={connecting}
          connectionError={connectionError}
          permissionBlocked={permissionBlocked}
          onShowContentChange={setShowContent}
          onConnect={() => void connectClaude()}
          onOpenClaude={() =>
            void invoke("open_claude").catch((error) =>
              setConnectionError(String(error)),
            )
          }
          onOpenAccessibility={() =>
            void invoke("open_accessibility_settings").catch((error) =>
              setConnectionError(String(error)),
            )
          }
          onResetAccessibility={() =>
            void resetAccessibility(setConnectionError)
          }
        />
      )}
    </div>
  );
}
