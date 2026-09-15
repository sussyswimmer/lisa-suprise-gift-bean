import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import BeanCompanion from "./components/BeanCompanion";
import BeanMark from "./components/BeanMark";
import ControlPanel from "./components/ControlPanel";
import WelcomeDialog from "./components/WelcomeDialog";
import { BeanManifest, BeanAssetState, ClaudeEvent } from "./types";
import { initialState, nextStateFromEvent, reducer } from "./state";
import { DEFAULT_ASSET_PACK, loadManifest, normalizeStatusForAsset } from "./beanAssets";

const PREFS_KEY = "bean.preferences.v1";
const DEFAULT_MANUAL_NOTE = "Official Bean report: you are very loved.";

// `window.isTauri` is only present when the optional global Tauri API is
// enabled. The module API works without that global, so detect its internal
// bridge instead and keep the production bundle connected to Rust.
function isBeanDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
  osc.stop(context.currentTime + 0.25);
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const [manifest, setManifest] = useState<BeanManifest>(DEFAULT_ASSET_PACK);
  const unlistenRef = useRef<(() => void) | null>(null);
  const lastCompletedTs = useRef<string>("");
  const [assetPackPath, setAssetPackPath] = useState("");
  const [showContent, setShowContent] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [accessMessage, setAccessMessage] = useState("");

  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    void loadManifest().then((nextManifest) => setManifest(nextManifest ?? DEFAULT_ASSET_PACK));
    if (isBeanDesktop()) {
      void invoke<string | null>("get_asset_pack_path", {}).then((saved) => {
        if (typeof saved === "string" && saved.length > 0) setAssetPackPath(saved);
      });
    }

    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        dispatch({ type: "loadPrefs", prefs: parsed.preferences as never });
        if (typeof parsed.note === "string") dispatch({ type: "setCurrentNote", value: parsed.note });
        if (typeof parsed.manualMessage === "string") dispatch({ type: "setManualMessage", value: parsed.manualMessage });
      } catch {
        dispatch({ type: "setManualMessage", value: DEFAULT_MANUAL_NOTE });
      }
    } else {
      dispatch({ type: "setManualMessage", value: DEFAULT_MANUAL_NOTE });
    }
  }, []);

  useEffect(() => {
    if (!isBeanDesktop()) return;
    void invoke("set_window_mode", { compact: state.preferences.welcomeShown });
  }, [state.preferences.welcomeShown]);
  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      version: 1,
      preferences: state.preferences,
      note: state.preferences.currentNote,
      manualMessage: state.preferences.manualMessage,
    }));
  }, [state.preferences]);

  const applyObserverEvent = useCallback((payload: ClaudeEvent) => {
    const current = stateRef.current;
    if (!payload || typeof payload.timestamp !== "string") return;

    const next = nextStateFromEvent(payload, current);
    dispatch({
      type: "setBean",
      state: next.beanState,
      statusText: next.statusText,
      session: payload.session,
      preview: payload.preview,
      source: payload.source as "chat" | "cowork" | "claude_code" | "system",
    });

    if (next.beanState === "happy" && payload.timestamp !== lastCompletedTs.current && next.preferences.lastCompletedAt !== payload.timestamp) {
      if (next.preferences.soundEnabled && !next.muted) playTone();
      lastCompletedTs.current = payload.timestamp;
    }
    dispatch({ type: "setUnavailable", unavailable: payload.status === "unavailable" });
  }, []);

  useEffect(() => {
    if (!isBeanDesktop()) return;
    let active = true;
    void listen<ClaudeEvent>("bean-claude-event", (event) => {
      if (!active) return;
      applyObserverEvent(event.payload);
    }).then((remove) => { unlistenRef.current = remove; });

    return () => {
      active = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [applyObserverEvent]);

  useEffect(() => {
    const receiveNativeStatus = (event: Event) => {
      const payload = (event as CustomEvent<ClaudeEvent>).detail;
      applyObserverEvent(payload);
    };
    window.addEventListener("bean-observer-status", receiveNativeStatus);
    return () => window.removeEventListener("bean-observer-status", receiveNativeStatus);
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
    const intervalId = window.setInterval(() => { void syncLatestObserverStatus(); }, 1_500);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [applyObserverEvent, state.preferences.welcomeShown]);

  useEffect(() => {
    if (!isBeanDesktop() || !state.preferences.welcomeShown) return;
    void invoke("start_observer", {}).catch(() => dispatch({ type: "setUnavailable", unavailable: true }));
    return () => { void invoke("stop_observer", {}); };
  }, [state.preferences.welcomeShown]);

  const mappedAsset = useMemo(() => {
    const source = { ...manifest.states } as BeanAssetState;
    return {
      idle: source.idle,
      noticed: source.noticed,
      thinking: source.thinking,
      message: source.message,
      happy: source.happy,
      sleepy: source.sleepy,
      soundOff: source.soundOff,
      ...(assetPackPath ? {
        idle: `${convertFileSrc(assetPackPath)}/idle.svg`,
        noticed: `${convertFileSrc(assetPackPath)}/noticed.svg`,
        thinking: `${convertFileSrc(assetPackPath)}/thinking.svg`,
        message: `${convertFileSrc(assetPackPath)}/message.svg`,
        happy: `${convertFileSrc(assetPackPath)}/happy.svg`,
        sleepy: `${convertFileSrc(assetPackPath)}/sleepy.svg`,
        soundOff: `${convertFileSrc(assetPackPath)}/sound-off.svg`,
      } : null),
    };
  }, [manifest, assetPackPath]);

  const handleDrag = async () => {
    if (!isBeanDesktop()) return;
    await invoke("drag_window");
  };

  const connectClaude = async () => {
    if (!isBeanDesktop()) return;
    setConnecting(true);
    setConnectionError("");
    try {
      try {
        await invoke("install_claude_code_hooks", { includeContent: showContent });
      } catch {
        // Claude Code hooks are optional; Claude Desktop Accessibility can still connect.
      }
      const accessibilityGranted = await invoke<boolean>("request_accessibility_permission");
      if (!accessibilityGranted) {
        throw new Error("Allow Bean in System Settings → Privacy & Security → Accessibility, then choose Connect again.");
      }
      await invoke("start_observer", {});
      dispatch({ type: "setWelcomeShown" });
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  };

  const toggleMonitoring = async () => {
    const nextPaused = !state.paused;
    dispatch({ type: "setPaused", paused: nextPaused });
    setAccessMessage(nextPaused ? "Monitoring paused until you resume it." : "Bean is watching Claude again.");

    if (!isBeanDesktop()) return;
    try {
      await invoke(nextPaused ? "stop_observer" : "start_observer", {});
    } catch {
      if (!nextPaused) {
        dispatch({ type: "setUnavailable", unavailable: true });
        setAccessMessage("Bean could not restart monitoring. Check Accessibility and try again.");
      }
    }
  };

  const checkAccessibility = async () => {
    if (!isBeanDesktop()) {
      setAccessMessage("Accessibility checks are available in the Bean desktop app.");
      return;
    }

    setCheckingAccess(true);
    setAccessMessage("");
    try {
      const granted = await invoke<boolean>("request_accessibility_permission");
      if (!granted) {
        dispatch({ type: "setUnavailable", unavailable: true });
        setAccessMessage("Turn on Bean in System Settings → Accessibility, then check again.");
        return;
      }
      await invoke("start_observer", {});
      dispatch({ type: "setUnavailable", unavailable: false });
      setAccessMessage("Accessibility is on. Bean is connected and listening.");
    } catch (error) {
      dispatch({ type: "setUnavailable", unavailable: true });
      setAccessMessage(error instanceof Error ? error.message : "Bean could not verify Accessibility.");
    } finally {
      setCheckingAccess(false);
    }
  };

  const currentAsset = mappedAsset[normalizeStatusForAsset(state.beanState)];

  return (
    <div className={`app-shell${state.preferences.welcomeShown ? "" : " app-welcome"}`}>
      {state.preferences.welcomeShown ? (
        <main className="shell-content">
          <header className="bean-topbar">
            <div className="bean-brand" aria-label="Bean companion">
              <BeanMark size={24} />
              <span>Bean</span>
            </div>
            <span className={`topbar-presence${state.unavailable ? " is-warning" : state.paused ? " is-muted" : ""}`}>
              {state.unavailable ? "Needs access" : state.paused ? "Paused" : "Watching"}
            </span>
            <button
              className={`settings-trigger${settingsOpen ? " is-open" : ""}`}
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-label={settingsOpen ? "Close Bean settings" : "Open Bean settings"}
              aria-expanded={settingsOpen}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path d="M9.7 3.3L10.3 2H13.7L14.3 3.3L16 4L17.4 3.5L19.8 5.9L19.2 7.4L20 9.1L21.4 9.7V13.1L20 13.7L19.2 15.4L19.8 16.9L17.4 19.3L16 18.8L14.3 19.5L13.7 20.8H10.3L9.7 19.5L8 18.8L6.6 19.3L4.2 16.9L4.8 15.4L4 13.7L2.6 13.1V9.7L4 9.1L4.8 7.4L4.2 5.9L6.6 3.5L8 4L9.7 3.3Z" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
                <circle cx="12" cy="11.4" r="3.1" stroke="currentColor" strokeWidth="1.65" />
              </svg>
              <span>Settings</span>
            </button>
          </header>
          <BeanCompanion
            state={state.beanState}
            statusText={state.statusText}
            source={state.source}
            session={state.session}
            preview={state.preview}
            asset={currentAsset}
            onDragStart={handleDrag}
          />
          <ControlPanel
            open={settingsOpen}
            unavailable={state.unavailable}
            paused={state.paused}
            soundEnabled={state.preferences.soundEnabled}
            showContent={showContent}
            checkingAccess={checkingAccess}
            accessMessage={accessMessage}
            onClose={() => setSettingsOpen(false)}
            onPauseToggle={() => void toggleMonitoring()}
            onSoundToggle={() => dispatch({ type: "setSound", soundEnabled: !state.preferences.soundEnabled })}
            onShowContentChange={setShowContent}
            onCheckAccess={() => void checkAccessibility()}
          />
        </main>
      ) : (
        <WelcomeDialog
          showContent={showContent}
          connecting={connecting}
          connectionError={connectionError}
          onShowContentChange={setShowContent}
          onConnect={() => void connectClaude()}
        />
      )}
    </div>
  );
}
