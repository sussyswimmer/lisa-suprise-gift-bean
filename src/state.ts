import { ClaudeEvent, ClaudeStatus, BeanState } from "./types";

export interface BeanPrefs {
  soundEnabled: boolean;
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
  preferences: BeanPrefs;
  lastStatusTs: string | null;
  preview: string | null;
}

const defaultPrefs: BeanPrefs = {
  soundEnabled: false,
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
  preferences: defaultPrefs,
  lastStatusTs: null,
  preview: null,
};

type Action =
  | {
      type: "setBean";
      state: BeanState;
      statusText: string;
      source?: "chat" | "cowork" | "claude_code" | "system";
      session?: string | null;
      preview?: string | null;
    }
  | { type: "setPaused"; paused: boolean }
  | { type: "setMuted"; muted: boolean }
  | { type: "setUnavailable"; unavailable: boolean }
  | { type: "setCurrentNote"; value: string }
  | { type: "setManualMessage"; value: string }
    | { type: "setSound"; soundEnabled: boolean }
    | { type: "setPhotoMode"; photoMode: boolean }
  | { type: "setWelcomeShown" }
  | { type: "loadPrefs"; prefs: Partial<BeanPrefs> }
  | { type: "resetForSession" };

export function reducer(state: CompanionState, action: Action): CompanionState {
  switch (action.type) {
    case "setBean":
      return {
        ...state,
        beanState: action.state,
        statusText: action.statusText,
        source: action.source ?? state.source,
        session: action.session ?? state.session,
        lastStatusTs: new Date().toISOString(),
        unavailable: false,
        preview: action.preview ?? state.preview,
      };
    case "setPaused":
      return {
        ...state,
        paused: action.paused,
        statusText: action.paused ? "Bean is paused" : "Observing Claude again",
      };
    case "setMuted":
      return { ...state, muted: action.muted };
    case "setUnavailable":
      if (!action.unavailable) {
        return {
          ...state,
          unavailable: false,
          beanState: state.unavailable ? "idle" : state.beanState,
          statusText: state.unavailable ? "Waiting and watching" : state.statusText,
        };
      }
      return {
        ...state,
        unavailable: true,
        beanState: "sleepy",
        statusText: "Accessibility not available yet — waiting for permission",
      };
    case "setCurrentNote":
      return { ...state, preferences: { ...state.preferences, currentNote: action.value } };
    case "setManualMessage":
      return { ...state, preferences: { ...state.preferences, manualMessage: action.value } };
    case "setSound":
      return {
        ...state,
        preferences: { ...state.preferences, soundEnabled: action.soundEnabled },
        beanState: action.soundEnabled && state.beanState === "soundOff" ? "idle" : action.soundEnabled ? state.beanState : "soundOff",
      };
    case "setPhotoMode":
      return { ...state, preferences: { ...state.preferences, photoMode: action.photoMode }, beanState: action.photoMode ? "message" : state.beanState };
    case "setWelcomeShown":
      return { ...state, preferences: { ...state.preferences, welcomeShown: true } };
    case "loadPrefs": {
      const merged = { ...state.preferences, ...action.prefs };
      const safe = {
        ...state.preferences,
        ...merged,
        soundEnabled: !!merged.soundEnabled,
        photoMode: !!merged.photoMode,
        paused: !!merged.paused,
      };
      return { ...state, preferences: safe, muted: !safe.soundEnabled, paused: safe.paused };
    }
    case "resetForSession":
      return {
        ...state,
        beanState: "sleepy",
        source: "system",
        session: null,
        statusText: "No active session",
      };
    default:
      return state;
  }
}

export function buildDedupKey(event: ClaudeEvent): string {
  return `${event.source}|${event.session ?? "none"}|${event.status}|${event.timestamp}`;
}

export function nextStateFromEvent(event: ClaudeEvent, now: CompanionState): CompanionState {
  const status = event.status;

  if (now.preferences.paused) {
    return now;
  }

  if (status === "unavailable") {
    return {
      ...now,
      unavailable: true,
      source: event.source,
      session: event.session,
      beanState: "sleepy",
      statusText: "Monitoring is unavailable right now",
      lastStatusTs: event.timestamp,
    };
  }

  if (status === "working") {
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "thinking",
      statusText: `${event.source === "claude_code" ? "Claude Code" : event.source === "chat" ? "Chat" : "Cowork"} is running`,
      lastStatusTs: event.timestamp,
      preview: event.preview ?? now.preview,
    };
  }

  if (status === "reply") {
    return { ...now, unavailable: false, source: event.source, session: event.session, beanState: "idle", statusText: "Claude replied", lastStatusTs: event.timestamp, preview: event.preview ?? null };
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
    const alreadySeen = now.preferences.lastEventKey === eventKey;
    if (alreadySeen) {
      return {
        ...now,
        lastStatusTs: event.timestamp,
        session: event.session,
        statusText: "Already handled this completion",
      };
    }
    return {
      ...now,
      unavailable: false,
      source: event.source,
      session: event.session,
      beanState: "happy",
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
