import {
  type CSSProperties,
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
import WelcomeDialog from "./components/WelcomeDialog";
import {
  BeanManifest,
  BeanAssetState,
  ClaudeEvent,
  claudeEventSchema,
} from "./types";
import {
  BeanSize,
  CELEBRATION_HOLD_MS,
  connectionMessage,
  initialState,
  nextStateFromEvent,
  reducer,
} from "./state";
import { isBeanDesktop, playTone } from "./platform";
import { BeanStatus, onMessageToBean, sendFromBean } from "./settingsBus";
import {
  DEFAULT_ASSET_PACK,
  loadManifest,
  normalizeStatusForAsset,
  preloadAssets,
} from "./beanAssets";

const PREFS_KEY = "bean.preferences.v1";

const BEAN_SCALE: Record<BeanSize, number> = {
  small: 0.8,
  medium: 1,
  large: 1.25,
};

// The status boxes above Bean's head; large still fits her 272 px window.
const BUBBLE_SCALE: Record<BeanSize, number> = {
  small: 0.78,
  medium: 1,
  large: 1.12,
};

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

  const beanScale = BEAN_SCALE[state.preferences.beanSize] ?? 1;
  const bubbleScale = BUBBLE_SCALE[state.preferences.bubbleSize] ?? 1;
  useEffect(() => {
    if (!isBeanDesktop()) return;
    void invoke("set_window_mode", {
      compact: state.preferences.welcomeShown,
      scale: beanScale,
    }).catch((error) => setAccessMessage(String(error)));
  }, [state.preferences.welcomeShown, beanScale]);

  useEffect(() => {
    if (!isBeanDesktop()) return;
    void invoke("set_always_on_top", {
      onTop: state.preferences.alwaysOnTop,
    }).catch((error) => setAccessMessage(String(error)));
  }, [state.preferences.alwaysOnTop]);

  // Keep the menu bar's Pause/Resume item in step with Bean.
  useEffect(() => {
    if (!isBeanDesktop()) return;
    void invoke("set_tray_state", { paused: state.paused }).catch(
      () => undefined,
    );
  }, [state.paused]);

  // Settings lives in its own window (opened from the menu bar). Bean's
  // window owns the preferences: it applies what Settings asks for, runs
  // connection checks, and reports its state back after every change.
  const permissionDenied =
    state.unavailableReason === "permission_denied" || permissionBlocked;
  const status: BeanStatus = {
    paused: state.paused,
    unavailable: state.unavailable,
    statusText: state.statusText,
    notice: accessMessage,
    permissionDenied,
    checkingAccess,
  };
  const reportRef = useRef({ prefs: state.preferences, status });
  const actionsRef = useRef({
    checkAccess: () => undefined as unknown,
    resetPermission: () => undefined as unknown,
  });
  useEffect(() => {
    reportRef.current = { prefs: state.preferences, status };
    sendFromBean({ type: "prefs", prefs: state.preferences, status });
    // Report only when something Settings shows has changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.preferences,
    state.paused,
    state.unavailable,
    state.statusText,
    accessMessage,
    permissionDenied,
    checkingAccess,
  ]);
  useEffect(
    () =>
      onMessageToBean((message) => {
        if (message.type === "patch")
          dispatch({ type: "patchPrefs", patch: message.patch });
        else if (message.type === "reset") dispatch({ type: "resetSettings" });
        else if (message.type === "checkAccess")
          actionsRef.current.checkAccess();
        else if (message.type === "resetPermission")
          actionsRef.current.resetPermission();
        else sendFromBean({ type: "prefs", ...reportRef.current });
      }),
    [],
  );
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
      if (next.preferences.soundEnabled && !next.muted)
        playTone(next.preferences.soundVolume);
    }
  }, []);

  // Apply the update that arrived during a celebration as soon as it ends.
  useEffect(() => {
    if (state.beanState !== "happy" || !state.heldEvent) return;
    const remaining =
      Date.parse(state.preferences.lastCompletedAt) +
      CELEBRATION_HOLD_MS -
      Date.now();
    const timeoutId = window.setTimeout(
      () => dispatch({ type: "releaseHeld" }),
      Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
    );
    return () => window.clearTimeout(timeoutId);
  }, [state.beanState, state.heldEvent, state.preferences.lastCompletedAt]);

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

  // "Pause Monitoring" in the menu bar.
  useEffect(() => {
    if (!isBeanDesktop()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<string>("bean-tray-action", (event) => {
      if (active && event.payload === "toggle-pause")
        dispatch({ type: "setPaused", paused: !stateRef.current.paused });
    })
      .then((remove) => {
        if (active) unlisten = remove;
        else remove();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

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

  useEffect(() => {
    actionsRef.current = {
      checkAccess: () => void checkAccessibility(),
      resetPermission: () => void resetAccessibility(setAccessMessage),
    };
  });

  const currentAsset = mappedAsset[normalizeStatusForAsset(state.beanState)];

  return (
    <div
      className={`app-shell${state.preferences.welcomeShown ? "" : " app-welcome"}`}
      style={
        {
          "--bean-scale": beanScale,
          "--bubble-scale": bubbleScale,
        } as CSSProperties
      }
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
            activities={assetPackPath ? {} : manifest.activities}
            disabledActivities={state.preferences.disabledActivities}
            activityFrequency={state.preferences.activityFrequency}
            showBubble={state.preferences.showBubble}
            onDragStart={handleDrag}
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
