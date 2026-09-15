import { describe, it, expect } from "vitest";
import { connectionMessage, nextStateFromEvent, initialState, reducer } from "./state";

describe("Bean state reducer", () => {
  it("distinguishes missing Claude from denied Accessibility", () => {
    const event = { source: "system" as const, session: null, status: "unavailable" as const, timestamp: "2026-09-15T00:00:00Z" };
    expect(connectionMessage({ ...event, reason: "claude_not_running" })).toContain("Open Claude Desktop");
    expect(connectionMessage({ ...event, reason: "permission_denied" })).toContain("Allow Bean");
    expect(connectionMessage({ ...event, reason: "interface_unavailable" })).toContain("not exposed");
  });

  it("applies complete events without discarding deduplication or session metadata", () => {
    const event = { source: "claude_code" as const, session: "s1", status: "completed" as const, timestamp: "2026-09-15T00:00:01Z" };
    const first = reducer(initialState, { type: "claudeEvent", event });
    expect(first.preferences.lastCompletedAt).toBe(event.timestamp);
    expect(reducer(first, { type: "claudeEvent", event }).statusText).toContain("Already handled");
    const lost = reducer(first, { type: "claudeEvent", event: { ...event, session: null, status: "unavailable", reason: "claude_not_running" } });
    expect(lost.session).toBeNull();
    expect(lost.preview).toBeNull();
    expect(lost.statusText).toContain("Open Claude Desktop");
  });

  it("clears previews when switching sessions", () => {
    const next = nextStateFromEvent({ source: "chat", session: "new", status: "working", timestamp: "2026-09-15T00:00:01Z" }, { ...initialState, session: "old", preview: "private old conversation" });
    expect(next.preview).toBeNull();
  });

  it("keeps typing through streamed reply text until Stop confirms completion", () => {
    const event = { source: "claude_code" as const, session: "s1", timestamp: "2026-09-15T00:00:01Z" };
    const working = reducer(initialState, { type: "claudeEvent", event: { ...event, status: "working" } });
    const replying = reducer(working, { type: "claudeEvent", event: { ...event, status: "reply", preview: "Writing the reply…" } });
    expect(replying.beanState).toBe("thinking");
    const done = reducer(replying, { type: "claudeEvent", event: { ...event, status: "completed", preview: "Final reply" } });
    expect(done.beanState).toBe("happy");
    expect(done.preview).toBe("Final reply");
  });
  it("keeps blocked status on unavailable event", () => {
    const withEvent = nextStateFromEvent(
      { source: "chat", session: "s1", status: "unavailable", timestamp: "2026-09-14T00:00:00Z" },
      initialState,
    );
    expect(withEvent.unavailable).toBe(true);
    expect(withEvent.beanState).toBe("sleepy");
  });

  it("switches to thinking on working", () => {
    const withEvent = nextStateFromEvent(
      { source: "cowork", session: "s2", status: "working", timestamp: "2026-09-14T00:00:01Z" },
      initialState,
    );
    expect(withEvent.beanState).toBe("thinking");
  });

  it("carries Claude Desktop text into the visible companion state", () => {
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
    expect(withEvent.preview).toBe("Here is the reply Claude is currently writing");
  });

  it("celebrates once per event", () => {
    const first = nextStateFromEvent(
      { source: "chat", session: "s3", status: "completed", timestamp: "2026-09-14T00:00:02Z" },
      initialState,
    );
    const second = nextStateFromEvent(
      { source: "chat", session: "s3", status: "completed", timestamp: "2026-09-14T00:00:02Z" },
      first,
    );
    expect(first.beanState).toBe("happy");
    expect(second.beanState).toBe("happy");
    expect(second.statusText).toContain("Already handled");
  });
});
