// @vitest-environment jsdom
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { initialState } from "./state";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: native.listen,
  emit: native.emit,
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  native.invoke.mockResolvedValue(null);
  native.listen.mockResolvedValue(vi.fn());
  native.emit.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function restore(prefs = {}) {
  localStorage.setItem(
    "bean.preferences.v1",
    JSON.stringify({
      preferences: {
        ...initialState.preferences,
        welcomeShown: true,
        ...prefs,
      },
    }),
  );
}
function event(status: string, preview?: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("bean-observer-status", {
        detail: {
          source: "claude_code",
          session: "s1",
          timestamp: "2026-09-22T00:00:00Z",
          status,
          preview,
        },
      }),
    );
  });
}

describe("native event integration", () => {
  it("restores pause before starting monitoring and ignores incoming work", async () => {
    restore({ paused: true });
    render(<App />);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("stop_observer"),
    );
    expect(
      native.invoke.mock.calls.some(
        ([command]) => command === "start_observer",
      ),
    ).toBe(false);
    event("working");
    expect(screen.queryByText("Claude Code is working")).toBeNull();
  });
  it("updates hook privacy and hides previews when the setting changes", async () => {
    restore({ showContent: true });
    render(<App />);
    event("working", "private preview");
    expect(screen.getByText("private preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Bean settings" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Show Claude Code previews" }),
    );
    expect(screen.queryByText("private preview")).toBeNull();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("install_claude_code_hooks", {
        includeContent: false,
      }),
    );
  });
  it("chimes once when the same completion arrives over multiple transports", () => {
    restore({ soundEnabled: true });
    const start = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const oscillator = {
      type: "",
      frequency: { value: 0 },
      connect: vi.fn(() => ({ connect: vi.fn() })),
      start,
      stop: vi.fn(),
      onended: null as null | (() => void),
    };
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
        destination = {};
        createOscillator = () => oscillator;
        createGain = () => ({ gain: { value: 0 } });
        close = close;
      },
    );
    render(<App />);
    event("completed");
    event("completed");
    expect(start).toHaveBeenCalledTimes(1);
    oscillator.onended?.();
    expect(close).toHaveBeenCalledOnce();
  });
  it("unsubscribes listeners whose registration finishes after StrictMode cleanup", async () => {
    const registrations: ((remove: () => void) => void)[] = [];
    native.listen.mockImplementation(
      () => new Promise<() => void>((resolve) => registrations.push(resolve)),
    );
    const view = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    const removers = registrations.map(() => vi.fn());
    await act(async () => {
      registrations.forEach((resolve, i) => resolve(removers[i]));
    });
    expect(removers[0]).toHaveBeenCalledOnce();
    view.unmount();
    expect(removers.every((remove) => remove.mock.calls.length === 1)).toBe(
      true,
    );
  });
});

describe("celebration timing", () => {
  it("shows work that arrived during a celebration once it ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    restore();
    render(<App />);
    const send = (status: string, session: string, second: number) =>
      act(() => {
        window.dispatchEvent(
          new CustomEvent("bean-observer-status", {
            detail: {
              source: "claude_code",
              session,
              status,
              timestamp: `2026-09-22T00:00:0${second}Z`,
            },
          }),
        );
      });
    send("completed", "s1", 0);
    send("working", "s2", 2);
    expect(screen.getByText("Reply is ready!")).toBeTruthy();
    act(() => vi.advanceTimersByTime(6_100));
    expect(screen.getByText("Claude Code is working")).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("menu bar and Settings window", () => {
  function handlers() {
    const byName = new Map<string, (event: { payload: unknown }) => void>();
    native.listen.mockImplementation(
      async (name: string, handler: (event: { payload: unknown }) => void) => {
        byName.set(name, handler);
        return vi.fn();
      },
    );
    return byName;
  }

  it("pauses from the menu bar and updates its menu item", async () => {
    restore();
    const byName = handlers();
    render(<App />);
    await waitFor(() => expect(byName.has("bean-tray-action")).toBe(true));
    act(() => byName.get("bean-tray-action")!({ payload: "toggle-pause" }));
    expect(screen.getByText("Paused")).toBeTruthy();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("set_tray_state", {
        paused: true,
      }),
    );
  });

  it("applies and saves changes sent from the Settings window", async () => {
    restore();
    const byName = handlers();
    render(<App />);
    await waitFor(() => expect(byName.has("bean-settings-to-main")).toBe(true));
    act(() =>
      byName.get("bean-settings-to-main")!({
        payload: {
          type: "patch",
          patch: { beanSize: "large", alwaysOnTop: false },
        },
      }),
    );
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("set_window_mode", {
        compact: true,
        scale: 1.25,
      }),
    );
    expect(native.invoke).toHaveBeenCalledWith("set_always_on_top", {
      onTop: false,
    });
    const saved = JSON.parse(localStorage.getItem("bean.preferences.v1")!);
    expect(saved.preferences.beanSize).toBe("large");
    // Bean reports the new settings back to the Settings window.
    expect(native.emit).toHaveBeenCalledWith(
      "bean-settings-from-main",
      expect.objectContaining({
        type: "prefs",
        prefs: expect.objectContaining({ beanSize: "large" }),
      }),
    );
  });
});
