import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import BeanCompanion from "./components/BeanCompanion";
import WelcomeDialog from "./components/WelcomeDialog";
import { BeanManifest, BeanAssetState, ClaudeEvent } from "./types";
import { initialState, nextStateFromEvent, reducer } from "./state";
import { DEFAULT_ASSET_PACK, loadManifest, normalizeStatusForAsset } from "./beanAssets";

const PREFS_KEY = "bean.preferences.v1";
const DEFAULT_MANUAL_NOTE = "Official Bean report: you are very loved.";
const appWindow = getCurrentWindow();

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

function isTauriEnv() {
  return typeof window !== "undefined" && typeof (window as Window & { __TAURI__?: unknown }).__TAURI__ !== "undefined";
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const [manifest, setManifest] = useState<BeanManifest>(DEFAULT_ASSET_PACK);
  const unlistenRef = useRef<(() => void) | null>(null);
  const lastCompletedTs = useRef<string>("");
  const [assetPackPath, setAssetPackPath] = useState("");

  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    void loadManifest().then((nextManifest) => setManifest(nextManifest ?? DEFAULT_ASSET_PACK));
    void invoke<string | null>("get_asset_pack_path", {}).then((saved) => {
      if (typeof saved === "string" && saved.length > 0) setAssetPackPath(saved);
    });

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
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      version: 1,
      preferences: state.preferences,
      note: state.preferences.currentNote,
      manualMessage: state.preferences.manualMessage,
    }));
  }, [state.preferences]);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let active = true;
    void listen<ClaudeEvent>("bean-claude-event", (event) => {
      if (!active) return;
      const payload = event.payload;
      const current = stateRef.current;
      if (!payload || typeof payload.timestamp !== "string") return;

      const next = nextStateFromEvent(payload, current);
      dispatch({
        type: "setBean",
        state: next.beanState,
        statusText: next.statusText,
        session: payload.session,
        source: payload.source as "chat" | "cowork" | "system",
      });

      if (next.beanState === "happy" && payload.timestamp !== lastCompletedTs.current && next.preferences.lastCompletedAt !== payload.timestamp) {
        if (next.preferences.soundEnabled && !next.muted) playTone();
        lastCompletedTs.current = payload.timestamp;
      }
      dispatch({ type: "setUnavailable", unavailable: payload.status === "unavailable" });
    }).then((remove) => { unlistenRef.current = remove; });

    return () => {
      active = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnv() || !state.preferences.welcomeShown) return;
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
    if (!isTauriEnv()) return;
    try { await appWindow.startDragging(); } catch { /* the native drag-region attribute remains available */ }
  };

  const connectClaude = async () => {
    if (isTauriEnv()) {
      try { await invoke("request_accessibility_permission"); } catch { /* observer will surface unavailable state */ }
    }
    dispatch({ type: "setWelcomeShown" });
  };

  const currentAsset = mappedAsset[normalizeStatusForAsset(state.beanState)];

  return (
    <div className={`app-shell${state.preferences.welcomeShown ? "" : " app-welcome"}`}>
      {state.preferences.welcomeShown ? (
        <main className="shell-content">
          <BeanCompanion
            state={state.beanState}
            statusText={state.statusText}
            source={state.source}
            session={state.session}
            asset={currentAsset}
            onDragStart={handleDrag}
          />
        </main>
      ) : (
        <WelcomeDialog onConnect={() => void connectClaude()} />
      )}
    </div>
  );
}
