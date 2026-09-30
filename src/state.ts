import { ClaudeEvent, BeanState } from "./types";

export interface BeanPrefs {
  soundEnabled: boolean;
  showContent: boolean;
  paused: boolean;
  welcomeShown: boolean;
  photoMode: boolean;
  currentNote: string;
  manualMessage: string;
  lastCompletedAt: string;
  lastEventKey: string | null;
}

export interface CompanionState {
  beanState: BeanState;
  statusText: string;
  source: "chat" | "cowork" | "claude_code" | "system";
  session: string | null;
  muted: boolean;
  paused: boolean;
  unavailable: boolean;
  /** Why monitoring is unavailable, e.g. "permission_denied". */
  unavailableReason: string | null;
  preferences: BeanPrefs;
  lastStatusTs: string | null;
  preview: string | null;
}

const defaultPrefs: BeanPrefs = {
  soundEnabled: false,
  showContent: false,
  paused: false,
  photoMode: false,
  welcomeShown: false,
  currentNote: "I’m here. Keep typing—Bean is watching.",
  manualMessage: "Official Bean report: you are very loved.",
  lastCompletedAt: "",
  lastEventKey: null,
};

export const initialState: CompanionState = {
  beanState: "sleepy",
  statusText: "Waiting for chat focus",
  source: "system",
  session: null,
  muted: true,
  paused: false,
  unavailable: false,
  unavailableReason: null,
  preferences: defaultPrefs,
  lastStatusTs: null,
  preview: null,
};

type Action =
  | { type: "claudeEvent"; event: ClaudeEvent }
  | {
      type: "setBean";
      state: BeanState;
      statusText: string;
      source?: "chat" | "cowork" | "claude_code" | "system";
      session?: string | null;
      preview?: string | null;
    }
  | { type: "setPaused"; paused: boolean }
  | { type: "setShowContent"; value: boolean }
  | { type: "setUnavailable"; unavailable: boolean; reason?: string }
  | { type: "setCurrentNote"; value: string }
  | { type: "setManualMessage"; value: string }
  | { type: "setSound"; soundEnabled: boolean }
  | { type: "setPhotoMode"; photoMode: boolean }
  | { type: "setWelcomeShown" }
  | { type: "loadPrefs"; prefs: unknown }
  | { type: "resetForSession" };

export function reducer(state: CompanionState, action: Action): CompanionState {
  switch (action.type) {
    case "claudeEvent":
      return nextStateFromEvent(action.event, state);
    case "setBean":
      return {
        ...state,
        beanState: action.state,
        statusText: action.statusText,
        source: action.source ?? state.source,
        session: action.session === undefined ? state.session : action.session,
        lastStatusTs: new Date().toISOString(),
        unavailable: false,
        preview: action.preview === undefined ? state.preview : action.preview,
      };
    case "setPaused":
      return {
        ...state,
        paused: action.paused,
        preferences: { ...state.preferences, paused: action.paused },
        statusText: action.paused ? "Bean is paused" : "Observing Claude again",
      };
    case "setShowContent":
      return {
        ...state,
        preview: action.value ? state.preview : null,
        preferences: { ...state.preferences, showContent: action.value },
      };

    case "setUnavailable":
      if (!action.unavailable) {
        return {
          ...state,
          unavailable: false,
          unavailableReason: null,
          beanState: state.unavailable ? "idle" : state.beanState,
          statusText: state.unavailable
            ? "Waiting and watching"
            : state.statusText,
        };
      }
      return {
        ...state,
        unavailable: true,
        unavailableReason: action.reason ?? null,
        beanState: "sleepy",
        statusText: "Accessibility not available yet — waiting for permission",
      };
    case "setCurrentNote":
      return {
        ...state,
        preferences: { ...state.preferences, currentNote: action.value },
      };
    case "setManualMessage":
      return {
        ...state,
        preferences: { ...state.preferences, manualMessage: action.value },
      };
    case "setSound":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          soundEnabled: action.soundEnabled,
        },
        muted: !action.soundEnabled,
      };
    case "setPhotoMode":
      return {
        ...state,
        preferences: { ...state.preferences, photoMode: action.photoMode },
        beanState: action.photoMode ? "message" : state.beanState,
      };
    case "setWelcomeShown":
      return {
        ...state,
        preferences: { ...state.preferences, welcomeShown: true },
      };
    case "loadPrefs": {
      const safe = sanitizePrefs(action.prefs, state.preferences);
      return {
        ...state,
        preferences: safe,
        muted: !safe.soundEnabled,
        paused: safe.paused,
        statusText: safe.paused ? "Bean is paused" : state.statusText,
      };
    }

    case "resetForSession":
      return {
        ...state,
        beanState: "sleepy",
        source: "system",
        session: null,
        statusText: "No active session",
        preview: null,
        unavailable: false,
        unavailableReason: null,
        lastStatusTs: null,
      };
    default:
      return state;
  }
}

export function sanitizePrefs(
  value: unknown,
  fallback: BeanPrefs = defaultPrefs,
): BeanPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ...fallback };
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(fallback).map(([key, defaultValue]) => [
      key,
      (typeof input[key] === typeof defaultValue && input[key] !== null) ||
      (key === "lastEventKey" &&
        (input[key] === null || typeof input[key] === "string"))
        ? input[key]
        : defaultValue,
    ]),
  ) as unknown as BeanPrefs;
}

/** How long "Reply is ready!" stays up before quiet updates replace it. */
export const CELEBRATION_HOLD_MS = 6_000;

export function buildDedupKey(event: ClaudeEvent): string {
  return JSON.stringify([
    event.source,
    event.session,
    event.status,
    event.timestamp,
  ]);
}

export function connectionMessage(event: ClaudeEvent): string {
  switch (event.reason) {
    case "permission_denied":
      return "Allow Bean in System Settings → Privacy & Security → Accessibility.";
    case "claude_not_running":
      return "Open Claude Desktop. Bean will connect when its window is readable.";
    case "window_unavailable":
      return "Claude is running, but its window is unavailable. Open a Claude conversation.";
    case "interface_scanning":
      return "Claude’s interface is taking longer to read. Bean is retrying; bring the conversation window forward.";
    case "interface_unresponsive":
      return "Claude is not responding to Accessibility yet. Bean is retrying.";
    case "interface_unavailable":
      return "Open a conversation in Claude’s main window, then refresh Bean’s connection. If it still cannot read the interface, quit and reopen Claude.";
    default:
      return event.status === "unavailable"
        ? "Claude monitoring is unavailable."
        : "Claude Desktop is readable. Bean is listening.";
  }
}

export function nextStateFromEvent(
  event: ClaudeEvent,
  now: CompanionState,
): CompanionState {
  const status = event.status;

  if (now.preferences.paused) {
    return now;
  }

  if (
    status === "completed" &&
    now.preferences.lastEventKey === buildDedupKey(event)
  )
    return now;
  if (
    now.lastStatusTs &&
    Date.parse(event.timestamp) < Date.parse(now.lastStatusTs)
  )
    return now;
  // Claude reports idle again within a second of finishing; let Bean finish
  // celebrating so the completion is actually noticeable. Work that another
  // session was already doing waits too; new work in the finished one does not.
  if (
    now.beanState === "happy" &&
    (status === "idle" ||
      status === "reply" ||
      status === "message" ||
      (status === "working" &&
        (event.source !== now.source || event.session !== now.session))) &&
    Date.parse(event.timestamp) - Date.parse(now.preferences.lastCompletedAt) <
      CELEBRATION_HOLD_MS
  )
    return now;
  const sameSession =
    now.session === event.session && now.source === event.source;
  const preview =
    now.preferences.showContent && event.source === "claude_code"
      ? event.preview === undefined
        ? sameSession
          ? now.preview
          : null
        : event.preview
      : null;
  now = {
    ...now,
    preview,
    unavailableReason: status === "unavailable" ? (event.reason ?? null) : null,
  };

  if (status === "unavailable") {
    return {
      ...now,
      unavailable: true,
      source: event.source,
      session: event.session,
      beanState: "sleepy",
      statusText: connectionMessage(event),
      preview: null,
      lastStatusTs: event.timestamp,
    };
  }

  if (status === "working" || status === "thinking") {
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "thinking",
      statusText: `${event.source === "claude_code" ? "Claude Code" : event.source === "chat" ? "Chat" : "Cowork"} is running`,
      lastStatusTs: event.timestamp,
      preview,
    };
  }

  if (status === "reply") {
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: now.beanState === "thinking" ? "thinking" : "idle",
      statusText: "Claude is replying",
      lastStatusTs: event.timestamp,
      preview,
    };
  }
  if (status === "message") {
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "message",
      statusText: "You are writing to Claude",
      lastStatusTs: event.timestamp,
    };
  }
  if (status === "completed") {
    const eventKey = buildDedupKey(event);
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "happy",
      preview,
      statusText: "Done — a completion heartbeat arrived",
      lastStatusTs: event.timestamp,
      preferences: {
        ...now.preferences,
        lastCompletedAt: event.timestamp,
        lastEventKey: eventKey,
      },
    };
  }

  if (status === "attention_needed") {
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "noticed",
      statusText: "Needs attention",
      lastStatusTs: event.timestamp,
    };
  }

  if (status === "failed" || status === "stopped") {
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "message",
      statusText: `Session ${status}`,
      lastStatusTs: event.timestamp,
    };
  }

  if (status === "idle") {
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "idle",
      statusText: "Waiting and watching",
      lastStatusTs: event.timestamp,
    };
  }

  return {
    ...now,
    unavailable: false,
    source: event.source,
    session: event.session,
    beanState: "idle",
    statusText: "State updated",
    lastStatusTs: event.timestamp,
  };
}
