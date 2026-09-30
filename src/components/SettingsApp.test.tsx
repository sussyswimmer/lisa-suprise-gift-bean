// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsApp from "./SettingsApp";
import { DEFAULT_ASSET_PACK } from "../beanAssets";
import { initialState } from "../state";
import type { FromBean } from "../settingsBus";

const bus = vi.hoisted(() => ({
  sendToBean: vi.fn(),
  listener: null as null | ((message: FromBean) => void),
}));
vi.mock("../settingsBus", () => ({
  sendToBean: bus.sendToBean,
  onMessageFromBean: (handler: (message: FromBean) => void) => {
    bus.listener = handler;
    return () => undefined;
  },
}));

const boba = { src: "/bean/sprites/boba.png", frames: 24, fps: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...DEFAULT_ASSET_PACK,
        activities: { boba, volleyball: { ...boba, src: "/v.png" } },
      }),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings window", () => {
  it("asks Bean for her settings and shows what she reports", () => {
    render(<SettingsApp />);
    expect(bus.sendToBean).toHaveBeenCalledWith({ type: "hello" });
    act(() =>
      bus.listener?.({
        type: "prefs",
        prefs: { ...initialState.preferences, paused: true },
        status: {
          paused: true,
          unavailable: false,
          statusText: "Bean is paused",
          notice: "",
          permissionDenied: false,
          checkingAccess: false,
        },
      }),
    );
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("switch", { name: "Monitor Claude" }),
    ).toHaveProperty("ariaChecked", "false");
  });

  it("sends each change to Bean's window", () => {
    render(<SettingsApp />);
    fireEvent.click(screen.getByRole("button", { name: /Appearance/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Large" }));
    expect(bus.sendToBean).toHaveBeenCalledWith({
      type: "patch",
      patch: { beanSize: "large" },
    });
    expect(screen.getByRole("radio", { name: "Large" })).toHaveProperty(
      "ariaChecked",
      "true",
    );
  });

  it("lists prop animations from the asset pack and toggles them", async () => {
    render(<SettingsApp />);
    fireEvent.click(screen.getByRole("button", { name: /Animations/ }));
    const volleyball = await screen.findByRole("switch", {
      name: "Playing volleyball",
    });
    // Dance has no sheet in this pack, so it is not offered.
    expect(screen.queryByRole("switch", { name: "A happy dance" })).toBeNull();
    fireEvent.click(volleyball);
    expect(bus.sendToBean).toHaveBeenLastCalledWith({
      type: "patch",
      patch: { disabledActivities: ["volleyball"] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn all on" }));
    expect(bus.sendToBean).toHaveBeenLastCalledWith({
      type: "patch",
      patch: { disabledActivities: [] },
    });
  });

  it("asks before resetting every setting", () => {
    render(<SettingsApp />);
    fireEvent.click(screen.getByRole("button", { name: /About & reset/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset settings…" }));
    expect(bus.sendToBean).not.toHaveBeenCalledWith({ type: "reset" });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(bus.sendToBean).toHaveBeenCalledWith({ type: "reset" });
  });

  it("offers Reset permission only when macOS blocks Bean", () => {
    render(<SettingsApp />);
    fireEvent.click(screen.getByRole("button", { name: /About & reset/ }));
    expect(
      screen.queryByRole("button", { name: "Reset permission" }),
    ).toBeNull();
    act(() =>
      bus.listener?.({
        type: "prefs",
        prefs: initialState.preferences,
        status: {
          paused: false,
          unavailable: true,
          statusText: "Waiting for permission",
          notice: "Allow Bean in System Settings.",
          permissionDenied: true,
          checkingAccess: false,
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset permission" }));
    expect(bus.sendToBean).toHaveBeenCalledWith({ type: "resetPermission" });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(bus.sendToBean).toHaveBeenCalledWith({ type: "checkAccess" });
    expect(screen.getByText("Allow Bean in System Settings.")).toBeTruthy();
  });
});
