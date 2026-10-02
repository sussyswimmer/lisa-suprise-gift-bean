import { describe, it, expect } from "vitest";
import {
  connectionMessage,
  nextStateFromEvent,
  initialState,
  reducer,
  sanitizePrefs,
} from "./state";

describe("Bean state reducer", () => {
  it("distinguishes missing Claude from denied Accessibility", () => {
    const event = {
      source: "system" as const,
      session: null,
      status: "unavailable" as const,
      timestamp: "2026-09-15T00:00:00Z",
    };
    expect(
      connectionMessage({ ...event, reason: "claude_not_running" }),
    ).toContain("Open Claude Desktop");
    expect(
      connectionMessage({ ...event, reason: "permission_denied" }),
    ).toContain("Allow Bean");
    expect(
      connectionMessage({ ...event, reason: "interface_unavailable" }),
    ).toContain("Open a conversation");
  });

  it("applies complete events without discarding deduplication or session metadata", () => {
    const event = {
      source: "claude_code" as const,
      session: "s1",
      status: "completed" as const,
      timestamp: "2026-09-15T00:00:01Z",
    };
    const first = reducer(initialState, { type: "claudeEvent", event });
    expect(first.preferences.lastCompletedAt).toBe(event.timestamp);
    expect(reducer(first, { type: "claudeEvent", event })).toBe(first);
    const lost = reducer(first, {
      type: "claudeEvent",
      event: {
        ...event,
        session: null,
        status: "unavailable",
        reason: "claude_not_running",
      },
    });
    expect(lost.session).toBeNull();
    expect(lost.preview).toBeNull();
    expect(lost.statusText).toContain("Open Claude Desktop");
  });

  it("clears previews when switching sessions", () => {
    const next = nextStateFromEvent(
      {
        source: "chat",
        session: "new",
        status: "working",
        timestamp: "2026-09-15T00:00:01Z",
      },
      { ...initialState, session: "old", preview: "private old conversation" },
    );
    expect(next.preview).toBeNull();
  });

  it("keeps typing through streamed reply text until Stop confirms completion", () => {
    const event = {
      source: "claude_code" as const,
      session: "s1",
      timestamp: "2026-09-15T00:00:01Z",
    };
    const working = reducer(
      {
        ...initialState,
        preferences: { ...initialState.preferences, showContent: true },
      },
      { type: "claudeEvent", event: { ...event, status: "working" } },
    );
    const replying = reducer(working, {
      type: "claudeEvent",
      event: { ...event, status: "reply", preview: "Writing the reply…" },
    });
    expect(replying.beanState).toBe("thinking");
    const done = reducer(replying, {
      type: "claudeEvent",
      event: { ...event, status: "completed", preview: "Final reply" },
    });
    expect(done.beanState).toBe("happy");
    expect(done.preview).toBe("Final reply");
  });
  it("keeps blocked status on unavailable event", () => {
    const withEvent = nextStateFromEvent(
      {
        source: "chat",
        session: "s1",
        status: "unavailable",
        timestamp: "2026-09-14T00:00:00Z",
      },
      initialState,
    );
    expect(withEvent.unavailable).toBe(true);
    expect(withEvent.beanState).toBe("sleepy");
  });

  it("switches to thinking on working", () => {
    const withEvent = nextStateFromEvent(
      {
        source: "cowork",
        session: "s2",
        status: "working",
        timestamp: "2026-09-14T00:00:01Z",
      },
      initialState,
    );
    expect(withEvent.beanState).toBe("thinking");
  });

  it("reacts when the user starts writing in Claude", () => {
    const withEvent = nextStateFromEvent(
      {
        source: "chat",
        session: "s2",
        status: "message",
        timestamp: "2026-09-14T00:00:01Z",
      },
      initialState,
    );
    expect(withEvent.beanState).toBe("message");
    expect(withEvent.statusText).toBe("You are writing to Claude");
  });

  it("clears a previous permission warning when monitoring resumes", () => {
    const blocked = reducer(initialState, {
      type: "setUnavailable",
      unavailable: true,
    });
    const resumed = reducer(blocked, {
      type: "setUnavailable",
      unavailable: false,
    });
    expect(resumed.unavailable).toBe(false);
    expect(resumed.beanState).toBe("idle");
    expect(resumed.statusText).toBe("Waiting and watching");
  });

  it("does not display Desktop chat content", () => {
    const withEvent = nextStateFromEvent(
      {
        source: "chat",
        session: "s2",
        status: "working",
        timestamp: "2026-09-14T00:00:01Z",
        preview: "Here is the reply Claude is currently writing",
      },
      initialState,
    );
    expect(withEvent.preview).toBeNull();
  });

  it("celebrates once per event", () => {
    const first = nextStateFromEvent(
      {
        source: "chat",
        session: "s3",
        status: "completed",
        timestamp: "2026-09-14T00:00:02Z",
      },
      initialState,
    );
    const second = nextStateFromEvent(
      {
        source: "chat",
        session: "s3",
        status: "completed",
        timestamp: "2026-09-14T00:00:02Z",
      },
      first,
    );
    expect(first.beanState).toBe("happy");
    expect(second.beanState).toBe("happy");
    expect(second).toBe(first);
  });
});

describe("completion celebration", () => {
  const completed = {
    source: "chat" as const,
    session: "s1",
    status: "completed" as const,
    timestamp: "2026-09-30T00:00:00Z",
  };
  it("keeps celebrating briefly when Claude immediately reports idle", () => {
    const happy = reducer(initialState, {
      type: "claudeEvent",
      event: completed,
    });
    const soon = reducer(happy, {
      type: "claudeEvent",
      event: {
        ...completed,
        status: "idle",
        timestamp: "2026-09-30T00:00:02Z",
      },
    });
    expect(soon.beanState).toBe("happy");
    const later = reducer(soon, {
      type: "claudeEvent",
      event: {
        ...completed,
        status: "idle",
        timestamp: "2026-09-30T00:00:07Z",
      },
    });
    expect(later.beanState).toBe("idle");
  });
  it("lets another session's ongoing work wait for the celebration", () => {
    const happy = reducer(initialState, {
      type: "claudeEvent",
      event: completed,
    });
    const other = reducer(happy, {
      type: "claudeEvent",
      event: {
        source: "claude_code",
        session: "code-1",
        status: "working",
        timestamp: "2026-09-30T00:00:01Z",
      },
    });
    expect(other.beanState).toBe("happy");
    expect(other.heldEvent?.session).toBe("code-1");
    // When the celebration ends the held work is shown, not lost.
    const after = reducer(other, { type: "releaseHeld" });
    expect(after.beanState).toBe("thinking");
    expect(after.session).toBe("code-1");
    expect(after.heldEvent).toBeNull();
  });
  it("shows a streamed reply as work in progress", () => {
    const replying = reducer(initialState, {
      type: "claudeEvent",
      event: {
        source: "claude_code",
        session: "s1",
        status: "reply",
        timestamp: "2026-09-30T00:00:00Z",
      },
    });
    expect(replying.beanState).toBe("thinking");
  });
  it("remembers why monitoring is unavailable until Claude is back", () => {
    const denied = reducer(initialState, {
      type: "claudeEvent",
      event: {
        source: "system",
        session: null,
        status: "unavailable",
        reason: "permission_denied",
        timestamp: "2026-09-30T00:00:00Z",
      },
    });
    expect(denied.unavailableReason).toBe("permission_denied");
    const back = reducer(denied, {
      type: "claudeEvent",
      event: {
        ...completed,
        status: "idle",
        timestamp: "2026-09-30T00:00:01Z",
      },
    });
    expect(back.unavailableReason).toBeNull();
  });
  it("still lets new work or attention interrupt the celebration", () => {
    const happy = reducer(initialState, {
      type: "claudeEvent",
      event: completed,
    });
    const working = reducer(happy, {
      type: "claudeEvent",
      event: {
        ...completed,
        status: "working",
        timestamp: "2026-09-30T00:00:01Z",
      },
    });
    expect(working.beanState).toBe("thinking");
  });
});

describe("persisted controls and event ordering", () => {
  const event = {
    source: "claude_code" as const,
    session: "s1",
    status: "working" as const,
    timestamp: "2026-09-15T00:00:01Z",
    preview: "private",
  };
  it("persists pause and ignores events until resumed", () => {
    const paused = reducer(initialState, { type: "setPaused", paused: true });
    const restored = reducer(initialState, {
      type: "loadPrefs",
      prefs: paused.preferences,
    });
    expect(restored.paused).toBe(true);
    expect(reducer(restored, { type: "claudeEvent", event })).toBe(restored);
    expect(
      reducer(reducer(restored, { type: "setPaused", paused: false }), {
        type: "claudeEvent",
        event,
      }).beanState,
    ).toBe("thinking");
  });
  it("enables sound without changing the activity animation", () => {
    const working = reducer(initialState, { type: "claudeEvent", event });
    const enabled = reducer(working, { type: "setSound", soundEnabled: true });
    expect(enabled.muted).toBe(false);
    expect(enabled.beanState).toBe("thinking");
    expect(
      reducer(enabled, { type: "setSound", soundEnabled: false }).beanState,
    ).toBe("thinking");
  });
  it("requires preview opt-in and clears text immediately when disabled", () => {
    expect(
      reducer(initialState, { type: "claudeEvent", event }).preview,
    ).toBeNull();
    const allowed = reducer(initialState, {
      type: "setShowContent",
      value: true,
    });
    const visible = reducer(allowed, { type: "claudeEvent", event });
    expect(visible.preview).toBe("private");
    const hidden = reducer(visible, { type: "setShowContent", value: false });
    expect(hidden.preview).toBeNull();
    expect(reducer(hidden, { type: "claudeEvent", event }).preview).toBeNull();
  });
  it("does not carry a preview across sessions on completion", () => {
    const allowed = reducer(initialState, {
      type: "setShowContent",
      value: true,
    });
    const visible = reducer(allowed, { type: "claudeEvent", event });
    expect(
      reducer(visible, {
        type: "claudeEvent",
        event: {
          ...event,
          session: "other",
          status: "completed",
          preview: undefined,
        },
      }).preview,
    ).toBeNull();
  });
  it("does not let a delayed cached event overwrite newer work", () => {
    const current = reducer(initialState, { type: "claudeEvent", event });
    expect(
      reducer(current, {
        type: "claudeEvent",
        event: { ...event, timestamp: "2026-09-14T00:00:00Z", status: "idle" },
      }),
    ).toBe(current);
  });
  it("rejects incorrectly typed persisted preferences", () => {
    const restored = reducer(initialState, {
      type: "loadPrefs",
      prefs: {
        paused: "false",
        welcomeShown: "yes",
        showContent: {},
        soundEnabled: 1,
      },
    });
    expect(restored.preferences).toEqual(initialState.preferences);
    expect(
      reducer(initialState, { type: "loadPrefs", prefs: null }).preferences,
    ).toEqual(initialState.preferences);
  });

  it("applies settings patches and ignores Bean's own bookkeeping", () => {
    const next = reducer(initialState, {
      type: "patchPrefs",
      patch: {
        beanSize: "large",
        soundEnabled: true,
        disabledActivities: ["boba"],
        // Not a setting: Settings must not be able to change this.
        lastEventKey: "forged",
      } as never,
    });
    expect(next.preferences.beanSize).toBe("large");
    expect(next.preferences.disabledActivities).toEqual(["boba"]);
    expect(next.muted).toBe(false);
    expect(next.preferences.lastEventKey).toBeNull();
  });

  it("pauses through a settings patch like the Pause button", () => {
    const paused = reducer(initialState, {
      type: "patchPrefs",
      patch: { paused: true },
    });
    expect(paused.paused).toBe(true);
    expect(paused.statusText).toBe("Bean is paused");
  });

  it("resets settings but keeps Bean connected", () => {
    const changed = reducer(
      reducer(initialState, { type: "setWelcomeShown" }),
      {
        type: "patchPrefs",
        patch: {
          beanSize: "small",
          bubbleSize: "large",
          soundVolume: 10,
          showBubble: false,
        },
      },
    );
    const reset = reducer(changed, { type: "resetSettings" });
    expect(reset.preferences.beanSize).toBe("medium");
    expect(reset.preferences.bubbleSize).toBe("medium");
    expect(reset.preferences.soundVolume).toBe(60);
    expect(reset.preferences.showBubble).toBe(true);
    expect(reset.preferences.welcomeShown).toBe(true);
  });

  it("rejects damaged settings from storage", () => {
    const prefs = sanitizePrefs({
      beanSize: "huge",
      bubbleSize: "giant",
      activityFrequency: 3,
      soundVolume: 400,
      disabledActivities: "boba",
      alwaysOnTop: "yes",
    });
    expect(prefs.beanSize).toBe("medium");
    expect(prefs.bubbleSize).toBe("medium");
    expect(prefs.activityFrequency).toBe("normal");
    expect(prefs.soundVolume).toBe(100);
    expect(prefs.disabledActivities).toEqual([]);
    expect(prefs.alwaysOnTop).toBe(true);
  });

  it("stays calm when reactions are switched off", () => {
    const quiet = reducer(initialState, {
      type: "patchPrefs",
      patch: { celebrateCompletions: false, alertOnAttention: false },
    });
    const done = nextStateFromEvent(
      {
        source: "chat",
        session: "s1",
        status: "completed",
        timestamp: "2026-09-30T00:00:01Z",
      },
      quiet,
    );
    expect(done.beanState).toBe("idle");
    // The completion is still recorded so it is not replayed later.
    expect(done.preferences.lastCompletedAt).toBe("2026-09-30T00:00:01Z");
    const needs = nextStateFromEvent(
      {
        source: "chat",
        session: "s1",
        status: "attention_needed",
        timestamp: "2026-09-30T00:00:02Z",
      },
      done,
    );
    expect(needs.beanState).toBe("idle");
  });
});
