import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import BeanCompanion from "./components/BeanCompanion";
import ControlPanel from "./components/ControlPanel";
import { BeanManifest, BeanAssetState, ClaudeEvent } from "./types";
import { initialState, nextStateFromEvent, reducer } from "./state";
import { DEFAULT_ASSET_PACK, loadManifest, normalizeStatusForAsset } from "./beanAssets";

const PREFS_KEY = "bean.preferences.v1";
const DEFAULT_MANUAL_NOTE = "Official Bean report: you are very loved.";
const appWindow = getCurrentWindow();

function playTone() {
  if (typeof AudioContext === "undefined") {
    return;
  }
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
  return (
    typeof window !== "undefined" &&
    typeof (window as Window & { __TAURI__?: unknown }).__TAURI__ !== "undefined"
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  const [manifest, setManifest] = useState<BeanManifest>(DEFAULT_ASSET_PACK);
  const [permissionKnown, setPermissionKnown] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  const lastCompletedTs = useRef<string>("");
  const [panelNote, setPanelNote] = useState(state.preferences.currentNote);
  const [panelManualNote, setPanelManualNote] = useState(state.preferences.manualMessage);
  const [assetPackPath, setAssetPackPath] = useState("");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    void loadManifest().then((nextManifest) => {
      setManifest(nextManifest ?? DEFAULT_ASSET_PACK);
    });
    void invoke<string | null>("get_asset_pack_path", {}).then((saved) => {
      if (typeof saved === "string" && saved.length > 0) {
        setAssetPackPath(saved);
      }
    });

    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        dispatch({ type: "loadPrefs", prefs: parsed.preferences as never });
        if (typeof parsed.note === "string") {
          dispatch({ type: "setCurrentNote", value: parsed.note });
        }
        if (typeof parsed.manualMessage === "string") {
          dispatch({ type: "setManualMessage", value: parsed.manualMessage });
        }
      } catch {
        // keep defaults
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
    const stopPrevious = unlistenRef.current;
    if (stopPrevious) {
      stopPrevious();
      unlistenRef.current = null;
    }

    if (!isTauriEnv()) {
      return;
    }

    let active = true;
    (async () => {
      const remove = await listen<ClaudeEvent>("bean-claude-event", (event) => {
        if (!active) return;
        const payload = event.payload;
        const current = stateRef.current;
        if (!payload || typeof payload.timestamp !== "string") {
          return;
        }

        const next = nextStateFromEvent(payload, current);
        dispatch({
          type: "setBean",
          state: next.beanState,
          statusText: next.statusText,
          session: payload.session,
          source: payload.source as "chat" | "cowork" | "system",
        });

        if (next.beanState === "happy") {
          if (payload.timestamp !== lastCompletedTs.current && next.preferences.lastCompletedAt !== payload.timestamp) {
            if (next.preferences.soundEnabled && !next.muted) {
              playTone();
            }
            if (next.preferences.soundEnabled && "Notification" in window) {
              const notify = () =>
                new Notification("Bean", {
                  body: `${payload.source.toUpperCase()} session ${payload.session ?? "task"} completed`,
                });
              if (Notification.permission === "granted") {
                notify();
              } else if (Notification.permission !== "denied") {
                void Notification.requestPermission().then((perm) => {
                  if (perm === "granted") notify();
                });
              }
            }
            lastCompletedTs.current = payload.timestamp;
            dispatch({ type: "setCurrentNote", value: current.preferences.currentNote });
          }
        }

        if (payload.status === "unavailable") {
          dispatch({ type: "setUnavailable", unavailable: true });
        } else {
          dispatch({ type: "setUnavailable", unavailable: false });
        }
      });
      unlistenRef.current = remove;
    })();

    return () => {
      active = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnv()) return;
    void invoke("start_observer", {}).catch(() => {
      dispatch({ type: "setUnavailable", unavailable: true });
    });
    return () => {
      void invoke("stop_observer", {});
    };
  }, []);

  useEffect(() => {
    setPanelNote(state.preferences.currentNote);
    setPanelManualNote(state.preferences.manualMessage);
  }, [state.preferences.currentNote, state.preferences.manualMessage]);

  const mappedAsset = useMemo(() => {
    const key = normalizeStatusForAsset(state.beanState);
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

  const handlePause = async () => {
    const next = !state.paused;
    dispatch({ type: "setPaused", paused: next });
    if (next) {
      await invoke("stop_observer", {});
    } else {
      await invoke("start_observer", {});
    }
  };

  const handleSound = () => {
    dispatch({
      type: "setSound",
      soundEnabled: !state.preferences.soundEnabled,
    });
  };

  const handleQuit = async () => {
    await invoke("quit_app", {});
  };

  const handleHide = async () => {
    if (isTauriEnv()) {
      await appWindow.hide();
    }
  };

  const handleGrant = async () => {
    await invoke("request_accessibility_permission", {});
    dispatch({ type: "setUnavailable", unavailable: false });
    setPermissionKnown(true);
  };

  const handleDrag = async () => {
    if (!isTauriEnv()) return;
    await appWindow.startDragging();
  };

  const handleManualMessage = (value: string) => {
    setPanelManualNote(value);
    dispatch({ type: "setManualMessage", value });
  };

  const handleNoteSave = (value: string) => {
    setPanelNote(value);
    dispatch({ type: "setCurrentNote", value });
  };

  const handleNoteReset = () => {
    handleNoteSave(DEFAULT_MANUAL_NOTE);
  };

  const handlePhotoMode = () => {
    dispatch({
      type: "setPhotoMode",
      photoMode: !state.preferences.photoMode,
    });
  };

  const updateAssetPack = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    try {
      const result = await invoke<{ manifestPath?: string }>("set_asset_pack_path", { path: trimmed });
      if (result?.manifestPath) {
        setAssetPackPath(trimmed);
      }
    } catch {
      dispatch({ type: "setBean", state: "noticed", statusText: "Asset pack path is invalid" });
    }
  };

  return (
    <div className="app-shell">
      <main className="shell-content">
        <BeanCompanion
          state={state.beanState}
          statusText={state.statusText}
          source={state.source}
          assets={mappedAsset}
          onDragStart={handleDrag}
        />
        <div className="message-strip" aria-live="polite">
          <p>{state.unavailable ? "Unavailable until permission is restored." : state.preferences.currentNote}</p>
          <p>{state.lastStatusTs ? `Updated ${new Date(state.lastStatusTs).toLocaleTimeString()}` : "Waiting for activity"}</p>
        </div>
        <ControlPanel
          isPaused={state.paused}
          isSoundEnabled={state.preferences.soundEnabled}
          isPhotoMode={state.preferences.photoMode}
          manualMessage={panelManualNote}
          note={panelNote}
          hasPermission={permissionKnown}
          onPauseToggle={handlePause}
          onSoundToggle={handleSound}
          onRequestGrant={handleGrant}
          onQuit={handleQuit}
          onHide={handleHide}
          onPhotoMode={handlePhotoMode}
          onManualMessage={handleManualMessage}
          onNoteSave={handleNoteSave}
          onNoteReset={handleNoteReset}
          onAssetPackPath={updateAssetPack}
        />
        <p className="caption">Bean status monitor for Claude Chat and Cowork</p>
      </main>
    </div>
  );
}
