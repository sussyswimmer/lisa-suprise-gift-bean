import { describe, it, expect } from "vitest";
import { nextStateFromEvent, initialState } from "./state";

describe("Bean state reducer", () => {
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
